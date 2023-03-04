import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { GCP_COMPONENT_PREFIX } from './constants';
import type { OutputWrapped } from '../../types';
import type { GcpRegionName } from './regions';
import { normalizeName } from '../../utils';

export interface EnvironmentGCPSecretData {
	version: OutputWrapped<string>;
	name: OutputWrapped<string>;
}

interface EnvironmentVariables {
	[name: string]: EnvironmentGCPSecretData | OutputWrapped<string | number> | {
		value: OutputWrapped<string | number>;
		secret: boolean;
	}
}

interface CloudRunEnvManagerInput {
	variables: EnvironmentVariables;
	serviceAccounts?: pulumi.Input<string[]>;
	secretRegionNames?: pulumi.Input<GcpRegionName[]>;
	prefix?: string;
}

function isEnvironmentGCPSecretData(val: any): val is EnvironmentGCPSecretData {
	return typeof val === 'object' && val && val.version && val.name;
}

export class EnvManager extends pulumi.ComponentResource implements CloudRunEnvManagerInput {
	#name: string;
	#prefix: string;

	readonly variables: EnvironmentVariables;
	readonly variableOutput: gcp.types.input.cloudrun.ServiceTemplateSpecContainerEnv[] = [];
	readonly serviceAccounts?: pulumi.Input<string[]>;
	readonly secretRegionNames?: pulumi.Input<GcpRegionName[]>;

	constructor(name: string, input: CloudRunEnvManagerInput, opts?: pulumi.CustomResourceOptions) {
		super(`${GCP_COMPONENT_PREFIX}:CloudRunEnvManager`, name, input, { ...opts });

		this.#name = name;
		this.#prefix = input.prefix ?? this.#name;
		this.serviceAccounts = input.serviceAccounts;
		this.secretRegionNames = input.secretRegionNames;
		this.variables = input.variables;

		for (const variableName in input.variables) {
			const valueOrWrapper = input.variables[variableName];
			if (isEnvironmentGCPSecretData(valueOrWrapper)) {
				this.variableOutput.push(this.registerExistingSecret(variableName, valueOrWrapper));

				continue;
			}

			let value = valueOrWrapper;
			let isSecret = false;

			if (typeof valueOrWrapper === 'object' && !pulumi.Output.isInstance(valueOrWrapper)) {
				value = valueOrWrapper.value;
				isSecret = valueOrWrapper.secret;
			}

			const asString = pulumi.output(value).apply(function(val) {
				return(String(val));
			});

			if (isSecret) {
				this.variableOutput.push(this.makeSecretVariable(variableName, asString));
				continue;
			}

			this.variableOutput.push({
				name: variableName,
				value: asString
			});
		}

		this.registerOutputs({ variableOutput: this.variableOutput });
	}

	private registerExistingSecret(name: string, secret: EnvironmentGCPSecretData) {
		const bindingName = normalizeName(this.#prefix, 'non-managed', name, 'iam-binding');

		if (!this.serviceAccounts) {
			throw new Error('Cannot create a secret binding without providing serviceAccounts and RegionName to EnvVariables()');
		}

		new gcp.secretmanager.SecretIamBinding(bindingName, {
			secretId: secret.name,
			members: this.serviceAccounts,
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

	private makeSecretVariable(name: string, value: OutputWrapped<string>) {
		const secretName = normalizeName(this.#prefix, name);

		if (!this.serviceAccounts || !this.secretRegionNames) {
			throw new Error('Cannot create secret without providing serviceAccount and RegionName to EnvVariables()');
		}

		let replicationConfig: gcp.secretmanager.SecretArgs['replication'] = { automatic: true };

		if (this.secretRegionNames) {
			replicationConfig = {
				userManaged: {
					replicas: pulumi.output(this.secretRegionNames).apply(function(resolvedRegions) {
						return resolvedRegions.map(function(region) {
							return({ location: region });
						});
					})
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

		new gcp.secretmanager.SecretIamBinding(`${secretName}-iam-binding`, {
			secretId: secret.secretId,
			members: this.serviceAccounts,
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
