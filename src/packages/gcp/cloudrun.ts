import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { GCP_COMPONENT_PREFIX } from './constants';
import type { OutputWrapped } from '../../types';
import type { GcpRegionName } from './regions';
import { normalizeName } from '../../utils';
import { getServiceAccountMemberID } from './misc';

interface EnvironmentVariables {
	[name: string]: OutputWrapped<string | number> | {
		value: OutputWrapped<string | number>;
		secret: boolean;
	}
}

interface CloudRunEnvManagerInput {
	variables: EnvironmentVariables;
	serviceAccount?: gcp.serviceaccount.Account;
	secretRegionName?: GcpRegionName;
	prefix?: string;
}

export class EnvManager extends pulumi.ComponentResource implements CloudRunEnvManagerInput {
	#name: string;
	#prefix: string;

	readonly variables: EnvironmentVariables;
	readonly variableOutput: gcp.types.input.cloudrun.ServiceTemplateSpecContainerEnv[] = [];
	readonly serviceAccount?: gcp.serviceaccount.Account;
	readonly secretRegionName?: GcpRegionName;

	constructor(name: string, input: CloudRunEnvManagerInput, opts?: pulumi.CustomResourceOptions) {
		super(`${GCP_COMPONENT_PREFIX}:CloudRunEnvManager`, name, input, { ...opts });

		this.#name = name;
		this.#prefix = input.prefix ?? this.#name;
		this.serviceAccount = input.serviceAccount;
		this.secretRegionName = input.secretRegionName;
		this.variables = input.variables;

		for (const variableName in input.variables) {
			const valueOrWrapper = input.variables[variableName];
			let value: OutputWrapped<string | number>;
			let secret = false;
			if (pulumi.Output.isInstance(valueOrWrapper)) {
				value = valueOrWrapper;
			} else if (typeof valueOrWrapper === 'object') {
				value = valueOrWrapper.value;
				secret = valueOrWrapper.secret;
			} else {
				value = valueOrWrapper;
			}

			const asString = pulumi.output(value).apply(function(val) {
				return(String(val));
			});

			if (!secret) {
				this.variableOutput.push({
					name: variableName,
					value: asString
				});

				continue;
			}

			this.variableOutput.push(this.makeSecretVariable(variableName, asString));
		}

		this.registerOutputs({ variableOutput: this.variableOutput });
	}

	private makeSecretVariable(name: string, value: OutputWrapped<string>) {
		const secretName = normalizeName(this.#prefix, name);

		if (!this.serviceAccount || !this.secretRegionName) {
			throw new Error('Cannot create secret without providing serviceAccount and RegionName to EnvVariables()');
		}

		const secret = new gcp.secretmanager.Secret(secretName, {
			secretId: secretName,
			replication: {
				userManaged: {
					replicas: [ { location: this.secretRegionName } ]
				}
			}
		}, { parent: this, deleteBeforeReplace: true });

		new gcp.secretmanager.SecretVersion(`${secretName}-version`, {
			secret: secret.id,
			secretData: pulumi.secret(value)
		}, { parent: secret });

		new gcp.secretmanager.SecretIamBinding(`${secretName}-iam-binding`, {
			secretId: secret.secretId,
			members: [ getServiceAccountMemberID(this.serviceAccount) ],
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
