import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import * as googleAuth from 'google-auth-library';
import type * as cloudbuildTypeImport from '@google-cloud/cloudbuild';

import { randomUUID } from 'crypto';

import type { DeepInput, DeepOutput } from '../../types';

export type IBuild = cloudbuildTypeImport.protos.google.devtools.cloudbuild.v1.IBuild;
export type IBuildOperationMetadata = cloudbuildTypeImport.protos.google.devtools.cloudbuild.v1.IBuildOperationMetadata;

interface CloudBuildInputs {
	build: IBuild;
	projectId: string | undefined;
	accessToken: string | undefined;
};

export enum HashType {
	NONE = 0,
	SHA256 = 1,
	MD5 = 2
}

async function createBuild(inputs: CloudBuildInputs) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires, no-type-assertion/no-type-assertion
	const cloudbuild = require('@google-cloud/cloudbuild').default as typeof cloudbuildTypeImport;

	const projectId = inputs.projectId;

	/*
	 * Authenticate to CloudBuild using the same credentials as the GCP provider.
	 */
	const accessToken = inputs.accessToken;
	let auth: googleAuth.GoogleAuth | undefined = undefined;
	if (accessToken !== undefined) {
		console.debug({accessToken});

		const authClient = new googleAuth.UserRefreshClient();
		authClient.setCredentials({
			access_token: accessToken,
		});

		new googleAuth.GoogleAuth({
			authClient: authClient
		});
	}

	const client = new cloudbuild.CloudBuildClient({
		projectId,
		auth
	});

	const [ operation ] = await client.createBuild({
		projectId: projectId,
		build: inputs.build,
	});

	const [ waitedResults ] = await operation.promise();

	if (waitedResults.results === undefined || waitedResults.results === null) {
		waitedResults.results = {};
	}

	const retval = {
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

	return(retval);
}
type BuildOutput = Awaited<ReturnType<typeof createBuild>>;
type PulumiBuildOutput = DeepOutput<BuildOutput>;

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

			/* XXX:TODO: Figure out how to pass in the access token */
			accessToken: undefined
		}

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
