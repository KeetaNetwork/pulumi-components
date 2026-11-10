import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { GCP_COMPONENT_PREFIX } from './constants';
import type { GCPRegion } from './constants';
import { normalizeName, inputApply } from '../../utils';
import { movedFrom, legacyUrn } from './aliases';
import type { OldParent } from './aliases';

export interface EnvironmentGCPSecretData {
	version: pulumi.Input<string>;
	name: pulumi.Input<string>;
}

export interface EnvironmentVariables {
	[name: string]: pulumi.Input<string | number> | EnvironmentGCPSecretData | {
		value: pulumi.Input<string | number>;
		secret: boolean;
	}
}

interface CloudRunEnvManagerInput {
	variables: EnvironmentVariables;
	serviceAccount?: pulumi.Input<string>;

	/**
	 * If not supplied, automatic replication will be used
	 */
	secretRegionName?: pulumi.Input<GCPRegion> | pulumi.Input<GCPRegion>[];
	prefix?: string;

	/**
	 * Environments of 1.0.95 that this one replaces (the worker and the
	 * migration job each had their own). A binding that one of them made for
	 * a secret that the caller owns is the same grant as the binding of this
	 * environment, and deleting it would revoke the access that this one
	 * relies on, so it is kept here, retained, at its old URN.
	 *
	 * @internal Set by `CloudRunService` for the managers it replaces.
	 */
	replaces?: ReplacedEnvironment[];
}

/** @internal A manager of 1.0.95 that an `EnvManager` replaces (see `replaces`) */
export interface ReplacedEnvironment {
	/** The name of the manager of 1.0.95 (it is the prefix of its resources) */
	name: string;

	/** Where that manager was in 1.0.95 */
	oldParent: OldParent;

	/** The variables that it did not hold (they were replaced by an override) */
	except?: string[];
}

/** The Cloud Run form of the variables of an environment, with its overrides */
export type ContainerEnv = Omit<gcp.types.input.cloudrun.ServiceTemplateSpecContainerEnv, 'name'> & {
	name: pulumi.Input<string>;
};

interface EnvOverrides {
	[name: string]: pulumi.Input<string>;
}

function isEnvironmentGCPSecretData(val: unknown): val is EnvironmentGCPSecretData {
	if (typeof val !== 'object' || val === null) {
		return(false);
	}

	if (!('version' in val) || !('name' in val)) {
		return(false);
	}

	return(true);
}

function toJobEnvs(entries: ContainerEnv[]): gcp.types.input.cloudrunv2.JobTemplateTemplateContainerEnv[] {
	return(entries.map(function(variable) {
		const variableName = pulumi.output(variable.name).apply(function(nameResolved) {
			if (nameResolved === undefined) {
				throw(new Error('name is undefined for CloudRunv2 Job variable'));
			}

			return(nameResolved);
		});

		let valueSourceContainer: { valueSource?: { secretKeyRef: { secret: pulumi.Output<string>; version: pulumi.Output<string> }}} = {};

		if (variable.valueFrom) {
			const secretKeyRef = pulumi.output(variable.valueFrom).apply(function(valueFrom) {
				if (valueFrom === undefined) {
					throw(new Error('valueFrom is undefined for CloudRunv2 Job variable'));
				}

				return({
					secret: valueFrom.secretKeyRef.name,
					version: valueFrom.secretKeyRef.key
				});
			});

			const valueSource = { secretKeyRef };
			valueSourceContainer = { valueSource };
		}

		if (valueSourceContainer.valueSource) {
			return({ name: variableName, ...valueSourceContainer });
		} else {
			return({ name: variableName, value: variable.value });
		}
	}));
}

/** One variable of an `EnvManager`: its value as given, and its Cloud Run form */
interface EnvEntry {
	variable: EnvironmentVariables[string];
	output: ContainerEnv;
}

/** One variable of a view: a variable of the manager, or an override */
type ViewEntry = { name: string; entry: EnvEntry } | { name: string; override: pulumi.Input<string> };

/**
 * The variables of a view, in order. An override takes the place of the
 * variable of the same name, and the other overrides follow the variables.
 */
function mergeOverrides(entries: ReadonlyMap<string, EnvEntry>, overrides: EnvOverrides): ViewEntry[] {
	const merged: ViewEntry[] = [];
	for (const [ name, entry ] of entries) {
		const override = overrides[name];
		if (override !== undefined) {
			merged.push({ name, override });
		} else {
			merged.push({ name, entry });
		}
	}

	for (const [ name, override ] of Object.entries(overrides)) {
		if (!entries.has(name)) {
			merged.push({ name, override });
		}
	}

	return(merged);
}

/**
 * The plain value of a variable, for a container that cannot read Secret
 * Manager. Throws when the variable references an existing secret.
 */
function resolveVariable(name: string, valueOrWrapper: EnvironmentVariables[string]): pulumi.Output<{ name: string; value: string }> {
	// An existing secret can only be read through Secret Manager, which these containers cannot do
	if (isEnvironmentGCPSecretData(valueOrWrapper)) {
		throw(new Error(`Variable ${name} references an existing secret, which cannot be resolved to a plain value for a container without Secret Manager support`));
	}

	let value: pulumi.Output<string | number>;
	if (typeof valueOrWrapper === 'object' && 'value' in valueOrWrapper) {
		// A literal that the caller marked secret stays a secret output, so the metadata that holds it is masked in the state
		value = pulumi.output(valueOrWrapper.value);
		if (valueOrWrapper.secret) {
			value = pulumi.secret(value);
		}
	} else {
		value = pulumi.output(valueOrWrapper);
	}

	return(value.apply(function(val) {
		return({ name, value: String(val) });
	}));
}

/**
 * What one runtime reads of an `EnvManager`: its variables, and the overrides
 * of that runtime. A view only projects what the manager made and creates no
 * resource, so a service, a job and a worker can read the same manager.
 */
export class EnvView {
	/** For a Cloud Run service */
	readonly cloudRun: ContainerEnv[];

	/** For a Cloud Run job or worker pool (the v2 form) */
	readonly cloudRunJob: gcp.types.input.cloudrunv2.JobTemplateTemplateContainerEnv[];

	readonly #entries: ViewEntry[];

	/**
	 * @internal Use `EnvManager.view()`, or `EnvView.ofOverrides()` for a
	 * runtime without a manager
	 */
	constructor(entries: ReadonlyMap<string, EnvEntry>, overrides: EnvOverrides) {
		this.#entries = mergeOverrides(entries, overrides);
		this.cloudRun = this.#entries.map(function(viewEntry) {
			if ('override' in viewEntry) {
				return({ name: viewEntry.name, value: viewEntry.override });
			}

			return(viewEntry.entry.output);
		});
		this.cloudRunJob = toJobEnvs(this.cloudRun);
	}

	/** The view of a runtime without an `EnvManager`: only its overrides */
	static ofOverrides(overrides: EnvOverrides = {}): EnvView {
		return(new EnvView(new Map(), overrides));
	}

	/**
	 * Plain values, for a virtual machine, which cannot read Secret Manager.
	 * Only reading this fails (and names the variable) when a variable
	 * references a secret that the caller owns.
	 */
	get resolvedForVm(): pulumi.Output<{ name: string; value: string }[]> {
		return(pulumi.all(this.#entries.map(function(viewEntry) {
			if ('override' in viewEntry) {
				return(pulumi.output(viewEntry.override).apply(function(val) {
					return({ name: viewEntry.name, value: String(val) });
				}));
			}

			return(resolveVariable(viewEntry.name, viewEntry.entry.variable));
		})));
	}
}

/**
 * The inputs that the component registers. `replaces` holds the URN of the
 * app, and a component cannot take an input that depends on its parent:
 * Pulumi waits for every child of a resource that an input depends on, and
 * this manager is one of them.
 */
function registeredInputs(input: CloudRunEnvManagerInput): Omit<CloudRunEnvManagerInput, 'replaces'> {
	return({
		variables: input.variables,
		serviceAccount: input.serviceAccount,
		secretRegionName: input.secretRegionName,
		prefix: input.prefix
	});
}

export class EnvManager extends pulumi.ComponentResource implements CloudRunEnvManagerInput {
	#name: string;
	#prefix: string;
	#replaces: ReplacedEnvironment[];
	readonly #entries = new Map<string, EnvEntry>();

	readonly variables: EnvironmentVariables;
	readonly variableOutput: ContainerEnv[] = [];
	readonly serviceAccount?: pulumi.Input<string>;
	readonly secretRegionName?: pulumi.Input<GCPRegion> | pulumi.Input<GCPRegion>[];

	constructor(name: string, input: CloudRunEnvManagerInput, opts?: pulumi.CustomResourceOptions) {
		super(`${GCP_COMPONENT_PREFIX}:CloudRunEnvManager`, name, registeredInputs(input), { ...opts });

		this.#name = name;
		this.#prefix = input.prefix ?? this.#name;
		this.#replaces = input.replaces ?? [];
		this.serviceAccount = input.serviceAccount;
		this.secretRegionName = input.secretRegionName;
		this.variables = input.variables;

		const convertValueToString = function(value: pulumi.Input<string | number>) {
			return(inputApply(value, function(val) {
				return(String(val));
			}));
		};

		for (const variableName in input.variables) {
			const valueOrWrapper = input.variables[variableName];
			let output: ContainerEnv;
			if (isEnvironmentGCPSecretData(valueOrWrapper)) {
				output = this.registerExistingSecret(variableName, valueOrWrapper);
			} else if (typeof valueOrWrapper === 'object' && 'value' in valueOrWrapper) {
				const asString = convertValueToString(valueOrWrapper.value);
				if (valueOrWrapper.secret) {
					output = this.makeSecretVariable(variableName, asString);
				} else {
					output = { name: variableName, value: asString };
				}
			} else {
				output = { name: variableName, value: convertValueToString(valueOrWrapper) };
			}

			this.variableOutput.push(output);
			this.#entries.set(variableName, { variable: valueOrWrapper, output });
		}

		this.registerOutputs({ variableOutput: this.variableOutput });
	}

	get cloudRunJobVariableOutput(): gcp.types.input.cloudrunv2.JobTemplateTemplateContainerEnv[] {
		return(toJobEnvs(this.variableOutput));
	}

	/**
	 * The variables as one runtime reads them. `overrides` are the variables
	 * of that runtime alone: they replace a variable of the same name. A view
	 * creates no resource.
	 */
	view(overrides: EnvOverrides = {}): EnvView {
		return(new EnvView(this.#entries, overrides));
	}

	/**
	 * Returns all variables with secrets resolved to their plain values.
	 * For use with GCE/MIG containers that don't support Secret Manager references.
	 * Throws when a variable references an existing secret, because it cannot be resolved.
	 */
	get resolvedVariableOutput(): pulumi.Output<{ name: string; value: string }[]> {
		return(this.view().resolvedForVm);
	}

	private registerExistingSecret(name: string, secret: EnvironmentGCPSecretData) {
		const bindingName = normalizeName(this.#prefix, 'non-managed', name, 'iam-binding');

		if (!this.serviceAccount) {
			throw(new Error('Cannot create a secret binding without providing serviceAccounts and RegionName to EnvVariables()'));
		}

		const binding = new gcp.secretmanager.SecretIamMember(bindingName, {
			secretId: secret.name,
			member: this.serviceAccount,
			role: 'roles/secretmanager.secretAccessor'
		}, { parent: this });

		this.keepReplacedBindings(name, secret, this.serviceAccount);

		return({
			name: name,
			valueFrom: {
				secretKeyRef: {
					key: secret.version ?? 'latest',
					name: pulumi.all([secret.name, binding.id]).apply(function([secretName]) {
						return(secretName);
					})
				}
			}
		});
	}

	/**
	 * The environments that this one replaces made the same binding of the
	 * same secret. Those bindings stay in the state as they are, at their
	 * URN, and are never deleted: removing one removes the member from the
	 * role in GCP, which would take away the access of the binding above.
	 */
	private keepReplacedBindings(variableName: string, secret: EnvironmentGCPSecretData, member: pulumi.Input<string>) {
		for (const replaced of this.#replaces) {
			if (replaced.except?.includes(variableName)) {
				continue;
			}

			const bindingName = normalizeName(replaced.name, 'non-managed', variableName, 'iam-binding');
			const managerUrn = legacyUrn(replaced.name, `${GCP_COMPONENT_PREFIX}:CloudRunEnvManager`, replaced.oldParent);

			new gcp.secretmanager.SecretIamMember(bindingName, {
				secretId: secret.name,
				member,
				role: 'roles/secretmanager.secretAccessor'
			}, {
				parent: this,
				retainOnDelete: true,
				aliases: movedFrom(bindingName, 'gcp:secretmanager/secretIamMember:SecretIamMember', { kind: 'resource', urn: managerUrn })
			});
		}
	}

	private makeSecretVariable(name: string, value: pulumi.Input<string>) {
		const secretName = normalizeName(this.#prefix, name);

		if (!this.serviceAccount) {
			throw(new Error('Cannot create secret without providing serviceAccount to EnvVariables()'));
		}

		let replicationConfig: gcp.secretmanager.SecretArgs['replication'] = {
			auto: {}
		};

		if (this.secretRegionName) {
			let regionNames = this.secretRegionName;
			if (!Array.isArray(regionNames)) {
				regionNames = [regionNames];
			}

			replicationConfig = {
				userManaged: {
					replicas: regionNames.map(function(regionName) {
						return({ location: regionName });
					})
				}
			};
		}

		const secret = new gcp.secretmanager.Secret(secretName, {
			secretId: secretName,
			replication: replicationConfig
		}, { parent: this, deleteBeforeReplace: true });

		/*
		 * A changed value replaces the version. The service and the job point
		 * at the new version's number, and the superseded version is disabled,
		 * not destroyed, once they do.
		 */
		const secretVersion = new gcp.secretmanager.SecretVersion(`${secretName}-version`, {
			secret: secret.id,
			secretData: pulumi.secret(value),
			deletionPolicy: 'DISABLE'
		}, {
			parent: this,
			aliases: movedFrom(`${secretName}-version`, 'gcp:secretmanager/secretVersion:SecretVersion', { kind: 'resource', urn: secret.urn }),
			deletedWith: secret
		});

		const binding = new gcp.secretmanager.SecretIamMember(`${secretName}-iam-binding`, {
			secretId: secret.secretId,
			member: this.serviceAccount,
			role: 'roles/secretmanager.secretAccessor'
		}, {
			parent: this,
			aliases: movedFrom(`${secretName}-iam-binding`, 'gcp:secretmanager/secretIamMember:SecretIamMember', { kind: 'resource', urn: secret.urn }),
			deletedWith: secret
		});

		return({
			name: name,
			valueFrom: {
				secretKeyRef: {
					key: secretVersion.version,
					name: pulumi.all([secret.secretId, binding.id]).apply(function([newSecretId]) {
						return(newSecretId);
					})
				}
			}
		});
	}
}

export default EnvManager;
