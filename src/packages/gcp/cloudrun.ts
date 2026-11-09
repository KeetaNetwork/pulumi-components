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

/**
 * Plain values of variables, for a container that cannot read Secret Manager.
 * An override replaces the variable of the same name. Throws when a variable
 * that is not replaced references an existing secret.
 */
function resolveVariables(variables: EnvironmentVariables, overrides: EnvOverrides): pulumi.Output<{ name: string; value: string }[]> {
	const entries: pulumi.Output<{ name: string; value: string }>[] = [];
	const overridden = new Set(Object.keys(overrides));
	for (const variableName in variables) {
		if (overridden.has(variableName)) {
			continue;
		}

		const valueOrWrapper = variables[variableName];

		// An existing secret can only be read through Secret Manager, which these containers cannot do
		if (isEnvironmentGCPSecretData(valueOrWrapper)) {
			throw(new Error(`Variable ${variableName} references an existing secret, which cannot be resolved to a plain value for a container without Secret Manager support`));
		}

		if (typeof valueOrWrapper === 'object' && 'value' in valueOrWrapper) {
			// A literal that the caller marked secret stays a secret output, so the metadata that holds it is masked in the state
			let value = pulumi.output(valueOrWrapper.value);
			if (valueOrWrapper.secret) {
				value = pulumi.secret(value);
			}

			entries.push(value.apply(function(val) {
				return({ name: variableName, value: String(val) });
			}));

			continue;
		}

		entries.push(pulumi.output(valueOrWrapper).apply(function(val) {
			return({ name: variableName, value: String(val) });
		}));
	}

	for (const variableName of overridden) {
		entries.push(pulumi.output(overrides[variableName]).apply(function(val) {
			return({ name: variableName, value: String(val) });
		}));
	}

	return(pulumi.all(entries));
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

	readonly #variables: EnvironmentVariables;
	readonly #overrides: EnvOverrides;

	/**
	 * @param variables The variables of the manager
	 * @param variableOutput Its Cloud Run form, in the order of `variables`
	 */
	constructor(variables: EnvironmentVariables, variableOutput: ContainerEnv[], overrides: EnvOverrides) {
		this.#variables = variables;
		this.#overrides = overrides;

		const names = Object.keys(variables);
		const overridden = new Set(Object.keys(overrides));
		const entries = variableOutput.map(function(entry, index) {
			const variableName = names[index];
			if (variableName !== undefined && overridden.has(variableName)) {
				return({ name: variableName, value: overrides[variableName] });
			}

			return(entry);
		});

		for (const variableName of overridden) {
			if (!names.includes(variableName)) {
				entries.push({ name: variableName, value: overrides[variableName] });
			}
		}

		this.cloudRun = entries;
		this.cloudRunJob = toJobEnvs(entries);
	}

	/**
	 * Plain values, for a virtual machine, which cannot read Secret Manager.
	 * Only reading this fails (and names the variable) when a variable
	 * references a secret that the caller owns.
	 */
	get resolvedForVm(): pulumi.Output<{ name: string; value: string }[]> {
		return(resolveVariables(this.#variables, this.#overrides));
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
			if (isEnvironmentGCPSecretData(valueOrWrapper)) {
				this.variableOutput.push(this.registerExistingSecret(variableName, valueOrWrapper));

				continue;
			}

			if (typeof valueOrWrapper === 'object' && 'value' in valueOrWrapper) {
				const { value, secret } = valueOrWrapper;

				const asString = convertValueToString(value);

				if (secret) {
					this.variableOutput.push(this.makeSecretVariable(variableName, asString));
					continue;
				}

				this.variableOutput.push({
					name: variableName,
					value: asString
				});

				continue;
			}

			this.variableOutput.push({
				name: variableName,
				value: convertValueToString(valueOrWrapper)
			});
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
		return(new EnvView(this.variables, this.variableOutput, overrides));
	}

	/**
	 * Returns all variables with secrets resolved to their plain values.
	 * For use with GCE/MIG containers that don't support Secret Manager references.
	 * Throws when a variable references an existing secret, because it cannot be resolved.
	 */
	get resolvedVariableOutput(): pulumi.Output<{ name: string; value: string }[]> {
		return(resolveVariables(this.variables, {}));
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
