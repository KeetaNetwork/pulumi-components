import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { GCP_COMPONENT_PREFIX } from './constants';
import type { GCPRegion } from './constants';
import { normalizeName, inputApply } from '../../utils';

export interface EnvironmentGCPSecretData {
	version: pulumi.Input<string>;
	name: pulumi.Input<string>;
}

interface EnvironmentVariables {
	[name: string]: pulumi.Input<string | number> | EnvironmentGCPSecretData | {
		value: pulumi.Input<string | number>;
		secret: boolean;
	}
}

interface CloudRunEnvManagerInput {
	variables: EnvironmentVariables;
	serviceAccount?: pulumi.Input<string>;
	secretRegionName?: pulumi.Input<GCPRegion>;
	prefix?: string;
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

export class EnvManager extends pulumi.ComponentResource implements CloudRunEnvManagerInput {
	#name: string;
	#prefix: string;

	readonly variables: EnvironmentVariables;
	readonly variableOutput: gcp.types.input.cloudrun.ServiceTemplateSpecContainerEnv[] = [];
	readonly serviceAccount?: pulumi.Input<string>;
	readonly secretRegionName?: pulumi.Input<GCPRegion>;

	constructor(name: string, input: CloudRunEnvManagerInput, opts?: pulumi.CustomResourceOptions) {
		super(`${GCP_COMPONENT_PREFIX}:CloudRunEnvManager`, name, input, { ...opts });

		this.#name = name;
		this.#prefix = input.prefix ?? this.#name;
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
		return(this.variableOutput.map(function(variable) {
			if (!variable.name) {
				throw new Error('Variable name is required for CloudRunv2 Jobs');
			}

			let valueSource;

			if (variable.valueFrom) {
				const secretKeyRef = pulumi.output(variable.valueFrom).apply(function(valueFrom) {
					return({
						secret: valueFrom.secretKeyRef.name,
						version: valueFrom.secretKeyRef.key
					});
				});

				valueSource = { secretKeyRef };
			}


			return({ name: variable.name, value: variable.value, valueSource });
		}));
	}

	private registerExistingSecret(name: string, secret: EnvironmentGCPSecretData) {
		const bindingName = normalizeName(this.#prefix, 'non-managed', name, 'iam-binding');

		if (!this.serviceAccount) {
			throw new Error('Cannot create a secret binding without providing serviceAccounts and RegionName to EnvVariables()');
		}

		new gcp.secretmanager.SecretIamMember(bindingName, {
			secretId: secret.name,
			member: this.serviceAccount,
			role: 'roles/secretmanager.secretAccessor'
		}, { parent: this });

		return({
			name: name,
			valueFrom: {
				secretKeyRef: {
					key: secret.version ?? 'latest',
					name: secret.name
				}
			}
		});
	}

	private makeSecretVariable(name: string, value: pulumi.Input<string>) {
		const secretName = normalizeName(this.#prefix, name);

		if (!this.serviceAccount || !this.secretRegionName) {
			throw new Error('Cannot create secret without providing serviceAccount and RegionName to EnvVariables()');
		}

		let replicationConfig: gcp.secretmanager.SecretArgs['replication'] = { automatic: true };

		if (this.secretRegionName) {
			replicationConfig = {
				userManaged: {
					replicas: [{ location: this.secretRegionName }]
				}
			};
		}

		const secret = new gcp.secretmanager.Secret(secretName, {
			secretId: secretName,
			replication: replicationConfig
		}, { parent: this, deleteBeforeReplace: true });

		new gcp.secretmanager.SecretVersion(`${secretName}-version`, {
			secret: secret.id,
			secretData: pulumi.secret(value)
		}, { parent: secret });

		new gcp.secretmanager.SecretIamMember(`${secretName}-iam-binding`, {
			secretId: secret.secretId,
			member: this.serviceAccount,
			role: 'roles/secretmanager.secretAccessor'
		}, { parent: secret });

		return({
			name: name,
			valueFrom: {
				secretKeyRef: {
					key: 'latest',
					name: secret.secretId
				}
			}
		});
	}
}

export default EnvManager;
