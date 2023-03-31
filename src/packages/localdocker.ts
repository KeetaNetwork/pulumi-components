import * as pulumi from '@pulumi/pulumi';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { promisifyExec } from '../utils';
import type { DeepInput } from '../types';

interface LocalBuildInputs {
	buildDirectory: string;
	secretContents?: string;
	buildArgs?: string[];
	imageCache?: string;
	imageURI: string;
	skipCleanBuildDirectory?: boolean;
	tags?: string[];
}

async function createBuild(inputs: LocalBuildInputs) {
	const toClean = [];

	if (inputs.skipCleanBuildDirectory !== true) {
		toClean.push(inputs.buildDirectory);
	}

	try {
		try {
			// Remove the local copy of the image
			await promisifyExec('docker', [ 'image', 'rm', inputs.imageURI ]);
		} catch {
			/* Ignore errors removing an image */
		}

		/*
         * Pull the cache image if appropriate
         */
		if (inputs.imageCache) {
			try {
				await promisifyExec('docker', [ 'pull', inputs.imageCache ]);
			} catch {
				/* Ignore errors attempt to pull cache image */
			}
		}

		/**
         * Compute the arguments for "docker build"
         */
		const buildArgs = [ '-t', inputs.imageURI, ...(inputs.buildArgs || [])];
		const env = { ...process.env };

		/**
         * Setup a socket for secrets for the build
         */
		if (inputs.secretContents) {
			const secretsDir = fs.mkdtempSync('/tmp/secrets-');

			const secretsFilePath = path.join(secretsDir, 'secrets');

			fs.writeFileSync(secretsFilePath, inputs.secretContents, { mode: 0o700 });

			toClean.push(secretsDir);

			buildArgs.push('--secret', `id=secrets,src=${secretsFilePath}`);

			env['DOCKER_BUILDKIT'] = '1';
		}

		/*
         * Run "docker build" to build the image
         */
		await promisifyExec('docker', ['build', ...buildArgs, inputs.buildDirectory], env);

		/*
         * Push the image
         */
		await promisifyExec('docker', [ 'image', 'push', inputs.imageURI ]);

		/**
         * Add the additional tags and push them
         */
		for (const taggedImage of inputs.tags ?? []) {
			await promisifyExec('docker', [ 'tag', inputs.imageURI, taggedImage ]);
			await promisifyExec('docker', [ 'image', 'push', taggedImage ]);
		}

		const imageInfoJSON = await promisifyExec('docker', [ 'image', 'inspect', inputs.imageURI ]);
		const imageInfo = JSON.parse(imageInfoJSON.stdout.join('\n'));
		const imageDigest = imageInfo[0].RepoDigests[0];

		if (typeof imageDigest !== 'string') {
			throw new Error('Failed to get image digest, it is not a string');
		}

		return({ digest: imageDigest });
	} catch (buildError) {
		console.log(`Failed to build local Docker image ${inputs.imageURI}:`, buildError);

		throw(buildError);
	} finally {
		for (const cleanPath of toClean) {
			fs.rmSync(cleanPath, { recursive: true, force: true });
		}
	}
}

const localImageProvider: pulumi.dynamic.ResourceProvider = {
	async check(_ignore_oldInput: LocalBuildInputs, newInput: LocalBuildInputs) {
		return({ inputs: { ...newInput }});
	},
	async create(inputs: LocalBuildInputs) {
		const id = randomUUID();
		const outs = await createBuild(inputs);

		return({ id, outs });
	},
	async update(_ignore_id, _ignore_oldInput, newInput: LocalBuildInputs) {
		const outs = await createBuild(newInput);
		return({ outs });
	},
	async delete() {
		return;
	}
};

export class LocalDockerImageBuilder extends pulumi.dynamic.Resource {
	public readonly digest!: pulumi.Output<string>;

	constructor(name: string, args: Exclude<DeepInput<LocalBuildInputs>, Promise<LocalBuildInputs>>, opts?: pulumi.CustomResourceOptions) {
		super(localImageProvider, name, {
			...args,
			digest: undefined
		}, opts);
	}
}

export default LocalDockerImageBuilder;
