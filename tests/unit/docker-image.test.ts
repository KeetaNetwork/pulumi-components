import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type * as docker from '../../src/packages/docker';
import { expectArray, expectRecord, expectString } from '../helpers/narrow';
import { requireSource } from './harness/load-sources';
import { captureTree, useIsolatedHome } from './harness/pulumi-tree';
import type { TreeSnapshot } from './harness/pulumi-tree';

const { LocalDockerImage } = requireSource<typeof docker>('src/packages/docker.ts');

type ImageInput = ConstructorParameters<typeof LocalDockerImage>[1];
type DirectoryOptions = Extract<ImageInput['buildDirectory'], { type: 'DIRECTORY' }>;

const APP_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/app');

function imageInput(name: string, buildDirectory: ImageInput['buildDirectory']): ImageInput {
	return({
		imageName: name,
		registryUrl: 'us-central1-docker.pkg.dev/project-id/keeta',
		versioning: { type: 'PLAIN', value: 'v1' },
		buildDirectory
	});
}

function directoryOptions(overrides: Partial<DirectoryOptions>): DirectoryOptions {
	return({ type: 'DIRECTORY', directory: APP_DIRECTORY, ...overrides });
}

describe('LocalDockerImage', function() {
	useIsolatedHome();

	async function build(name: string, buildDirectory: ImageInput['buildDirectory']) {
		let cacheTag: string | undefined;
		const tree = await captureTree(function() {
			const image = new LocalDockerImage(name, imageInput(name, buildDirectory));
			cacheTag = image.inputCacheTag;

			return(image);
		});

		return({ tree, cacheTag });
	}

	/** The arguments the local builder is given for `docker build` */
	function builderBuildArgs(tree: TreeSnapshot): string[] {
		const builder = tree.resources.find(function(resource) {
			return(resource.name.endsWith('-docker-builder'));
		});
		const args = expectArray(expectRecord(builder?.inputs, 'the docker builder inputs').buildArgs, 'the docker builder buildArgs');

		return(args.map(function(arg) {
			return(expectString(arg, 'a docker builder argument'));
		}));
	}

	/*
	 * The cache ID of the tarball is the caller's `inputCacheTag` when there
	 * is one, and the image exposes it.
	 */
	const cacheTags: [ string, ImageInput['buildDirectory'], string | undefined ][] = [
		[ 'a directory with an inputCacheTag', directoryOptions({ inputCacheTag: 'my-cache-tag' }), 'my-cache-tag' ],
		[ 'a directory without an inputCacheTag', directoryOptions({}), undefined ],
		[ 'a plain directory path', APP_DIRECTORY, undefined ]
	];

	it.each(cacheTags)('exposes the cache tag for %s', async function(description, buildDirectory, expected) {
		const { cacheTag } = await build(`cache-tag-${description.replace(/ /g, '-')}`, buildDirectory);

		expect(cacheTag).toBe(expected);
	});

	it('gives docker build the Dockerfile relative to the build directory, never a temporary path', async function() {
		const { tree } = await build('relative-dockerfile', directoryOptions({ dockerfilePath: 'Dockerfile' }));
		const args = builderBuildArgs(tree);

		expect(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2)).toEqual([ '-f', 'Dockerfile' ]);
		expect(args.filter(function(arg) {
			return(arg.includes('docker-build-') || arg.includes('<tmp>'));
		})).toEqual([]);
	});

	it('gives docker build no Dockerfile argument when the caller names none', async function() {
		const { tree } = await build('no-dockerfile-path', directoryOptions({}));

		expect(builderBuildArgs(tree)).not.toContain('-f');
	});
});
