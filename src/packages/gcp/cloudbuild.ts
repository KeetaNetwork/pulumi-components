import * as pulumi from '@pulumi/pulumi';
import { randomUUID } from 'crypto';
import type * as cloudbuildTypeImport from '@google-cloud/cloudbuild';
import type { DeepInput } from '../../types';

export type IBuild = cloudbuildTypeImport.protos.google.devtools.cloudbuild.v1.IBuild;
export type IBuildOperationMetadata = cloudbuildTypeImport.protos.google.devtools.cloudbuild.v1.IBuildOperationMetadata;

interface CloudBuildInputs {
	build: IBuild;
}

export enum HashType {
	NONE = 0,
	SHA256 = 1,
	MD5 = 2
}

async function createBuild(inputs: IBuild) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires, no-type-assertion/no-type-assertion
	const cloudbuild = require('@google-cloud/cloudbuild').default as typeof cloudbuildTypeImport;
	const client = new cloudbuild.CloudBuildClient({});
	const [ operation ] = await client.createBuild({
		build: inputs
	});
	const [ metadata ] = await operation.promise();

	return({ metadata, operation });
}


const cloudbuildProvider: pulumi.dynamic.ResourceProvider = {
	async check(olds: CloudBuildInputs, news: CloudBuildInputs) {
		return({
			inputs: {
				...olds,
				...news
			}
		});
	},
	async create(inputs: CloudBuildInputs) {
		return({
			id: randomUUID(),
			outs: await createBuild(inputs.build)
		});
	},
	async update(_ignore_id, _ignore_olds, news: CloudBuildInputs) {
		return({
			outs: await createBuild(news.build)
		});
	},
	async delete() {
		return;
	}
};

export class CloudBuild extends pulumi.dynamic.Resource {
	readonly operation!: pulumi.Output<IBuild>;
	readonly metadata!: pulumi.Output<IBuildOperationMetadata>;

	constructor(name: string, args: DeepInput<CloudBuildInputs>, opts?: pulumi.CustomResourceOptions) {
		super(cloudbuildProvider, name, args, opts);
	}
}
