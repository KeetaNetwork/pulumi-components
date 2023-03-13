import * as pulumi from '@pulumi/pulumi';
import { randomUUID } from 'crypto';
import type * as cloudbuild from '@google-cloud/cloudbuild';
import type { DeepInput } from '../../types';

export type IBuild = cloudbuild.protos.google.devtools.cloudbuild.v1.IBuild;
export type IBuildOperationMetadata = cloudbuild.protos.google.devtools.cloudbuild.v1.IBuildOperationMetadata;

interface CloudBuildInputs {
	build: IBuild;
}

export enum HashType {
	NONE = 0,
	SHA256 = 1,
	MD5 = 2
}

async function createBuild(inputs: IBuild) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { default: { CloudBuildClient }} = require('@google-cloud/cloudbuild');
	const cloudBuild = new CloudBuildClient({});
	const [ operation ] = await cloudBuild.createBuild({ build: inputs});
	const [ metadata ] = await operation.promise();

	return({ metadata, operation });
}


const cloudbuildProvider: pulumi.dynamic.ResourceProvider = {
	async check(olds: CloudBuildInputs, news: CloudBuildInputs) {
		return({ inputs: { ...olds, ...news }});
	},
	async create(inputs: CloudBuildInputs) {
		return({ id: randomUUID(), outs: await createBuild(inputs.cb) });
	},
	async update(_ignore_id, _ignore_olds, news: CloudBuildInputs) {
		return({ outs: await createBuild(news.cb) });
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
