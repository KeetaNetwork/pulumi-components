import * as pulumi from '@pulumi/pulumi';
import * as googleAuth from 'google-auth-library';
import type * as cloudbuildTypeImport from '@google-cloud/cloudbuild';
import type * as secretManagerTypeImport from '@google-cloud/secret-manager';

import { randomUUID } from 'crypto';
import type * as fsTypeImport from 'fs';
import type * as utilTypeImport from 'util';

import type { DeepInput, DeepOutput } from '../../types';
import { authenticateAs, clientAuthInputs, googleAuthFrom } from './client-auth';
import type { ClientAuthInputs, ClientAuthProvider } from './client-auth';

export type IBuild = cloudbuildTypeImport.protos.google.devtools.cloudbuild.v1.IBuild;
export type IBuildOperationMetadata = cloudbuildTypeImport.protos.google.devtools.cloudbuild.v1.IBuildOperationMetadata;
export type ISecrets = cloudbuildTypeImport.protos.google.devtools.cloudbuild.v1.ISecrets;

interface TemporarySecretInput {
	secretParent?: string;
	input: string;
	secretId: string;
}

interface SourceUploadInput {
	bucket: string;
	object: string;
	/**
	 * Local path of the tarball, which differs between machines so it
	 * is not considered when diffing
	 */
	path: string;
}

interface CloudBuildInputs {
	build: IBuild;
	temporarySecret?: TemporarySecretInput;
	sourceUpload?: SourceUploadInput;
	projectId: string | undefined;

	/** Who runs the build (never part of a diff) */
	auth?: ClientAuthInputs;
}

export enum HashType {
	NONE = 0,
	SHA256 = 1,
	MD5 = 2
}

type BuildOutput = Awaited<ReturnType<typeof createBuild>>;
type PulumiBuildOutput = DeepOutput<BuildOutput>;

/**
 * Upload the source tarball unless an object with that name already
 * exists -- object names are derived from the image version so an
 * existing object already holds the same source
 */
async function uploadSource(upload: SourceUploadInput, authInputs?: ClientAuthInputs) {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-require-imports
	const fs = require('fs') as typeof fsTypeImport;

	const scopes = [ 'https://www.googleapis.com/auth/devstorage.read_write' ];
	let auth = new googleAuth.GoogleAuth({ scopes });
	if (authInputs !== undefined) {
		auth = googleAuthFrom(authInputs, scopes);
	}

	const client = await auth.getClient();

	try {
		await client.request({
			url: `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(upload.bucket)}/o`,
			method: 'POST',
			params: {
				uploadType: 'media',
				name: upload.object,
				ifGenerationMatch: '0'
			},
			headers: {
				'Content-Type': 'application/gzip'
			},
			data: fs.readFileSync(upload.path)
		});
	} catch (error: unknown) {
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const requestError = (error as { status?: number; response?: { status?: number }} | undefined);
		if (requestError?.status === 412 || requestError?.response?.status === 412) {
			return;
		}

		throw(error);
	}
}

/**
 * Determine if a build needs to be re-run.  Only the build definition
 * and project are compared, so the secret value, who runs the build and the local path of
 * the source tarball (which vary between users and machines) do not
 * cause a rebuild.
 */
function cloudBuildHasChanges(olds: Partial<Pick<CloudBuildInputs, 'build' | 'projectId' | 'auth'>>, news: Pick<CloudBuildInputs, 'build' | 'projectId' | 'auth'>): boolean {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-require-imports
	const { isDeepStrictEqual } = require('util') as typeof utilTypeImport;

	if (!isDeepStrictEqual(olds.build, news.build)) {
		return(true);
	}

	return((olds.projectId ?? undefined) !== (news.projectId ?? undefined));
}

async function createBuild(inputs: CloudBuildInputs) {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-member-access
	const cloudbuild = require('@google-cloud/cloudbuild').default as typeof cloudbuildTypeImport;
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-member-access
	const secretManager = require('@google-cloud/secret-manager').default as typeof secretManagerTypeImport;

	const projectId = inputs.projectId;

	const gcpClientConfig = { projectId };
	const secretClient = new secretManager.SecretManagerServiceClient(gcpClientConfig);
	const client = new cloudbuild.CloudBuildClient(gcpClientConfig);

	/* The clients find the credentials of the environment themselves; `auth` only says who to impersonate */
	if (inputs.auth !== undefined) {
		authenticateAs(secretClient, '@google-cloud/secret-manager', inputs.auth);
		authenticateAs(client, '@google-cloud/cloudbuild', inputs.auth);
	}

	const cleanupFunctions = [];

	let retval;
	let error: unknown;

	try {
		if (inputs.sourceUpload !== undefined) {
			await uploadSource(inputs.sourceUpload, inputs.auth);
		}

		if (inputs.temporarySecret !== undefined) {
			const { secretId, input, secretParent } = inputs.temporarySecret;

			/**
			 * Life-time of secret (in seconds), we set it to expire
			 * after this time
			 */
			const secretTTL = 300;

			/**
			 * Do not try to delete the secret after the expiration
			 * period to avoid conflicting with duplicate builds
			 */
			const secretNoDeleteAfter = new Date();
			secretNoDeleteAfter.setSeconds(secretNoDeleteAfter.getSeconds() + secretTTL + 60);

			/**
			 * Create a secret to hold the input secrets
			 */
			const [ secret ] = await secretClient.createSecret({
				parent: secretParent ?? `projects/${projectId}`,
				secretId: secretId,
				secret: {
					name: secretId,
					replication: { automatic: {}},
					ttl: {
						seconds: secretTTL
					}
				}
			});

			cleanupFunctions.push(async function() {
				const now = Date.now();
				if (now > secretNoDeleteAfter.getTime()) {
					return;
				}

				try {
					await secretClient.deleteSecret({ name: secret.name });
				} catch {
					/* Ignore failures to delete */
				}
			});

			if (inputs.build.serviceAccount) {
				const serviceAccountEmail = inputs.build.serviceAccount.split('/serviceAccounts/')[1];
				if (!serviceAccountEmail) {
					throw(new Error(`Invalid service account: ${inputs.build.serviceAccount}, should match /projects/**/serviceAccounts/email@...`));
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
			statusDetail: waitedResults.statusDetail ?? null,
			build: inputs.build,
			projectId: inputs.projectId
		};
	} catch (e) {
		error = e;
	}

	for (const cleanupFunc of cleanupFunctions) {
		await cleanupFunc();
	}

	if (error) {
		if (error instanceof Error) {
			throw(error);
		}
		throw(new Error('Build failed with unknown error'));
	}

	if (!retval) {
		throw(new Error('retval is undefined, could not make build'));
	}

	return(retval);
}

export const _Testing = {
	cloudBuildHasChanges
};

const cloudbuildProvider: pulumi.dynamic.ResourceProvider = {
	async check(_ignore_oldInput: CloudBuildInputs, newInput: CloudBuildInputs) {
		const retval = {
			inputs: {
				...newInput
			}
		};

		return(retval);
	},
	async diff(_ignore_id, olds: Partial<CloudBuildInputs>, news: CloudBuildInputs) {
		return({
			changes: cloudBuildHasChanges(olds, news)
		});
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
	gcpProvider: ClientAuthProvider;
	build: DeepInput<IBuild>;
	temporarySecret?: DeepInput<TemporarySecretInput>;
	sourceUpload?: DeepInput<SourceUploadInput>;
}

export class CloudBuild extends pulumi.dynamic.Resource implements PulumiBuildOutput {
	declare public readonly status: pulumi.Output<BuildOutput['status']>;
	declare public readonly results: pulumi.Output<BuildOutput['results']>;
	declare public readonly logUrl: pulumi.Output<BuildOutput['logUrl']>;
	declare public readonly statusDetail: pulumi.Output<BuildOutput['statusDetail']>;
	declare public readonly build: pulumi.Output<BuildOutput['build']>;
	declare public readonly projectId: pulumi.Output<BuildOutput['projectId']>;

	static HashType = HashType;

	constructor(name: string, args: CloudBuildInputsArg, opts?: pulumi.CustomResourceOptions) {
		const passArgs: DeepInput<CloudBuildInputs> = {
			build: args.build,
			projectId: args.gcpProvider.project,
			auth: clientAuthInputs(args.gcpProvider),
			temporarySecret: args.temporarySecret,
			sourceUpload: args.sourceUpload
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
