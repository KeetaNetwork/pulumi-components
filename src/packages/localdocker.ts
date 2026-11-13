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
	cleanBuildDirectory?: boolean;
	tags?: string[];
}

/**
 * The repository of an image URI in the form `docker image inspect` lists it:
 * the URI without its tag (a colon only starts a tag when no "/" follows it,
 * otherwise it separates a registry port), and for Docker Hub without
 * "docker.io/" and "library/".
 */
function imageRepository(imageURI: string) {
	const colon = imageURI.lastIndexOf(':');
	let repository = imageURI;
	if (colon !== -1 && !imageURI.slice(colon).includes('/')) {
		repository = imageURI.slice(0, colon);
	}

	/* "docker image inspect" lists Docker Hub images in their short form: "user/image", and "image" for "library/image" */
	return(repository.replace(/^docker\.io\//, '').replace(/^library\//, ''));
}

/**
 * Choose the digest of the image that was built from the `RepoDigests`
 * of `docker image inspect`, which lists one entry per repository the image
 * is known in. It is the entry of the repository in the image's own URI.
 */
function pickRepoDigest(repoDigests: string[], imageURI: string) {
	const repository = imageRepository(imageURI);
	const found = repoDigests.find(function(entry) {
		return(entry.split('@')[0] === repository);
	});

	if (found === undefined) {
		throw(new Error(`Failed to get image digest, none of ${repoDigests.length} RepoDigests entries belongs to ${repository}`));
	}

	return(found);
}

function sameList(left: string[] | undefined, right: string[] | undefined) {
	const leftItems = left ?? [];
	const rightItems = right ?? [];

	return(leftItems.length === rightItems.length && leftItems.every(function(item, index) {
		return(item === rightItems[index]);
	}));
}

/**
 * Whether the image to build differs.  The build directory is a fresh
 * temporary directory on every run and the secrets are only read by the
 * build, so neither says the image is different.
 */
function localBuildHasChanges(olds: Partial<LocalBuildInputs>, news: Partial<LocalBuildInputs>) {
	return(olds.imageURI !== news.imageURI ||
		(olds.imageCache ?? undefined) !== (news.imageCache ?? undefined) ||
		!sameList(olds.buildArgs, news.buildArgs) ||
		!sameList(olds.tags, news.tags));
}

export const _Testing = {
	pickRepoDigest,
	localBuildHasChanges
};

async function createBuild(inputs: LocalBuildInputs) {
	const toClean = [];

	if (inputs.cleanBuildDirectory === true) {
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
		const buildArgs = [ '-t', inputs.imageURI];
		if (inputs.buildArgs) {
			buildArgs.push(...inputs.buildArgs);
		}

		const env = { ...process.env };

		/**
		 * Setup a socket for secrets for the build
		 */
		if (inputs.secretContents) {
			const secretsDir = fs.mkdtempSync('/tmp/secrets-');

			const secretsFilePath = path.join(secretsDir, 'secrets');

			fs.writeFileSync(secretsFilePath, inputs.secretContents, { mode: 0o600 });

			toClean.push(secretsDir);

			buildArgs.push('--secret', `id=secrets,src=${secretsFilePath}`);

			env['DOCKER_BUILDKIT'] = '1';
		}

		/*
		 * Run "docker build" to build the image
		 */
		await promisifyExec('docker', ['build', ...buildArgs, '.'], env, inputs.buildDirectory);

		/*
		 * Authenticate Docker to the registry before pushing
		 */
		const registryHost = inputs.imageURI.split('/')[0];
		if (registryHost) {
			await promisifyExec('gcloud', ['auth', 'configure-docker', registryHost, '--quiet']);
		}

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
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
		const imageInfo = JSON.parse(imageInfoJSON.stdout.join('\n')) as { RepoDigests: unknown[] }[];
		const repoDigests = (imageInfo[0]?.RepoDigests ?? []).filter(function(entry): entry is string {
			return(typeof entry === 'string');
		});

		return({ digest: pickRepoDigest(repoDigests, inputs.imageURI) });
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
	diff(_ignore_id: string, olds: LocalBuildInputs, news: LocalBuildInputs) {
		return(Promise.resolve({ changes: localBuildHasChanges(olds, news) }));
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
	declare public readonly digest: pulumi.Output<string>;

	constructor(name: string, args: Exclude<DeepInput<LocalBuildInputs>, Promise<LocalBuildInputs>>, opts?: pulumi.CustomResourceOptions) {
		super(localImageProvider, name, {
			...args,
			digest: undefined
		}, opts);
	}
}

export default LocalDockerImageBuilder;
