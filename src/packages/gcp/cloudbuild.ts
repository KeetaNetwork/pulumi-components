import * as pulumi from '@pulumi/pulumi';
import type * as gcp from '@pulumi/gcp';
import * as googleAuth from 'google-auth-library';
import type * as cloudbuildTypeImport from '@google-cloud/cloudbuild';
import type * as secretManagerTypeImport from '@google-cloud/secret-manager';

import { randomUUID } from 'crypto';

import type { DeepInput, DeepOutput } from '../../types';

export type IBuild = cloudbuildTypeImport.protos.google.devtools.cloudbuild.v1.IBuild;
export type IBuildOperationMetadata = cloudbuildTypeImport.protos.google.devtools.cloudbuild.v1.IBuildOperationMetadata;
export type ISecrets = cloudbuildTypeImport.protos.google.devtools.cloudbuild.v1.ISecrets;

interface TemporarySecretInput {
	secretParent?: string;
	input: string;
	secretId: string;
}

interface CloudBuildInputs {
	build: IBuild;
	temporarySecret?: TemporarySecretInput;
	projectId: string | undefined;
	accessToken: string | undefined;
}

export enum HashType {
	NONE = 0,
	SHA256 = 1,
	MD5 = 2
}

type BuildOutput = Awaited<ReturnType<typeof createBuild>>;
type PulumiBuildOutput = DeepOutput<BuildOutput>;

async function createBuild(inputs: CloudBuildInputs) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires, no-type-assertion/no-type-assertion
	const cloudbuild = require('@google-cloud/cloudbuild').default as typeof cloudbuildTypeImport;
	// eslint-disable-next-line @typescript-eslint/no-var-requires, no-type-assertion/no-type-assertion
	const secretManager = require('@google-cloud/secret-manager').default as typeof secretManagerTypeImport;

	const projectId = inputs.projectId;

	/*
	 * Authenticate to CloudBuild using the same credentials as the GCP provider.
	 */
	const accessToken = inputs.accessToken;
	const auth: googleAuth.GoogleAuth | undefined = undefined;
	if (accessToken !== undefined) {
		const authClient = new googleAuth.UserRefreshClient();
		authClient.setCredentials({
			access_token: accessToken
		});

		new googleAuth.GoogleAuth({
			authClient: authClient
		});
	}

	const gcpClientConfig = { projectId, auth };
	const secretClient = new secretManager.SecretManagerServiceClient(gcpClientConfig);
	const client = new cloudbuild.CloudBuildClient(gcpClientConfig);

	const cleanupFunctions = [];

	let retval;
	let error: any;

	try {
		if (inputs.temporarySecret !== undefined) {
			const { secretId, input, secretParent } = inputs.temporarySecret;

			const [ secret ] = await secretClient.createSecret({
				parent: secretParent ?? `projects/${projectId}`,
				secretId: secretId,
				secret: {
					name: secretId,
					replication: { automatic: {}}
				}
			});

			cleanupFunctions.push(async function() {
				await secretClient.deleteSecret({ name: secret.name });
			});

			if (inputs.build.serviceAccount) {
				const serviceAccountEmail = inputs.build.serviceAccount.split('/serviceAccounts/')[1];
				if (!serviceAccountEmail) {
					throw new Error(`Invalid service account: ${inputs.build.serviceAccount}, should match /projects/**/serviceAccounts/email@...`);
				}

				await secretClient.setIamPolicy({
					resource: secret.name,
					policy: {
						bindings: [
							{
								role: 'roles/secretmanager.secretAccessor',
								members: [ `serviceAccount:${serviceAccountEmail}` ]
							}
						]
					}
				});
			} else {
				console.warn('inputs.build.serviceAccount is not set, but a temporary secret is being created. IAM policy will not be set.');
			}


			const versionContents = input;

			await secretClient.addSecretVersion({
				parent: secret.name,
				payload: {
					data: Buffer.from(versionContents, 'utf8')
				}
			});
		}

		const [ operation ] = await client.createBuild({
			projectId: projectId,
			build: inputs.build
		});

		const [ waitedResults ] = await operation.promise();

		if (waitedResults.results === undefined || waitedResults.results === null) {
			waitedResults.results = {};
		}

		retval = {
			status: waitedResults.status ?? 'UNKNOWN',
			results: {
				images: (waitedResults.results.images ?? []).map(function(image) {
					return({
						name: image.name ?? null,
						digest: image.digest ?? null
					});
				}),
				artifactManifest: waitedResults.results.artifactManifest ?? null,
				numArtifacts: waitedResults.results.numArtifacts ? Number(waitedResults.results.numArtifacts) : null
			},
			logUrl: waitedResults.logUrl ?? null,
			statusDetail: waitedResults.statusDetail ?? null
		};
	} catch (e) {
		error = e;
	}

	for (const cleanupFunc of cleanupFunctions) {
		await cleanupFunc();
	}

	if (error) {
		throw error;
	}

	if (!retval) {
		throw new Error('retval is undefined, could not make build');
	}

	return retval;
}

const cloudbuildProvider: pulumi.dynamic.ResourceProvider = {
	async check(oldInput: CloudBuildInputs, newInput: CloudBuildInputs) {
		const retval = {
			inputs: {
				...oldInput,
				...newInput
			}
		};

		return(retval);
	},
	async create(inputs: CloudBuildInputs) {
		const id = randomUUID();
		const output = await createBuild(inputs);

		const retval = {
			id: id,
			outs: output
		};

		return(retval);
	},
	async update(_ignore_id, _ignore_oldInput, newInput: CloudBuildInputs) {
		const output = await createBuild(newInput);
		const retval = {
			outs: output
		};

		return(retval);
	},
	async delete() {
		return;
	}
};

interface CloudBuildInputsArg {
	gcpProvider: Pick<gcp.Provider, 'project'>;
	build: DeepInput<IBuild>;
	temporarySecret?: DeepInput<TemporarySecretInput>;
}

export class CloudBuild extends pulumi.dynamic.Resource implements PulumiBuildOutput {
	public readonly status!: pulumi.Output<BuildOutput['status']>;
	public readonly results!: pulumi.Output<BuildOutput['results']>;
	public readonly logUrl!: pulumi.Output<BuildOutput['logUrl']>;
	public readonly statusDetail!: pulumi.Output<BuildOutput['statusDetail']>;

	static HashType = HashType;

	constructor(name: string, args: CloudBuildInputsArg, opts?: pulumi.CustomResourceOptions) {
		const passArgs: DeepInput<CloudBuildInputs> = {
			build: args.build,
			projectId: args.gcpProvider.project,
			temporarySecret: args.temporarySecret,

			/* XXX:TODO: Figure out how to pass in the access token */
			accessToken: undefined
		};

		super(cloudbuildProvider, name, {
			...passArgs,
			status: undefined,
			results: undefined,
			logUrl: undefined,
			statusDetail: undefined
		}, opts);
	}
}

export default CloudBuild;
