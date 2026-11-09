import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type * as docker from '../../src/packages/docker';
import { expectArray, expectRecord, expectString } from '../helpers/narrow';
import { useTempDirectories } from '../helpers/temp-directories';
import { requireSource } from './harness/load-sources';
import { captureTree, useIsolatedHome } from './harness/pulumi-tree';
import type { TreeSnapshot } from './harness/pulumi-tree';

const { LocalDockerImage, getFileResourceIdentifier } = requireSource<typeof docker>('src/packages/docker.ts');

type ImageInput = ConstructorParameters<typeof LocalDockerImage>[1];
type DirectoryOptions = Extract<ImageInput['buildDirectory'], { type: 'DIRECTORY' }>;

const APP_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/app');

function imageInput(name: string, buildDirectory: ImageInput['buildDirectory'], versioning: ImageInput['versioning'] = { type: 'PLAIN', value: 'v1' }): ImageInput {
	return({
		imageName: name,
		registryUrl: 'us-central1-docker.pkg.dev/project-id/keeta',
		versioning,
		buildDirectory
	});
}

function directoryOptions(overrides: Partial<DirectoryOptions>): DirectoryOptions {
	return({ type: 'DIRECTORY', directory: APP_DIRECTORY, ...overrides });
}

describe('LocalDockerImage', function() {
	useIsolatedHome();

	const directories = useTempDirectories();

	async function build(name: string, buildDirectory: ImageInput['buildDirectory'], versioning?: ImageInput['versioning']) {
		let cacheTag: string | undefined;
		const tree = await captureTree(function() {
			const image = new LocalDockerImage(name, imageInput(name, buildDirectory, versioning));
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

	/** The image reference that the local builder is told to build and push */
	function builderImageURI(tree: TreeSnapshot) {
		const builder = tree.resources.find(function(resource) {
			return(resource.name.endsWith('-docker-builder'));
		});

		return(expectString(expectRecord(builder?.inputs, 'the docker builder inputs').imageURI, 'the docker builder imageURI'));
	}

	/* The tag is the version: a value, a hash of the files, or the commit of the repository */
	const versions: [ string, ImageInput['versioning'], RegExp ][] = [
		[ 'PLAIN: the value that was given', { type: 'PLAIN', value: 'v1' }, /:v1$/ ],
		[ 'FILE: a hash of the files', { type: 'FILE', fromFile: APP_DIRECTORY }, /:hash_[0-9a-f]+$/ ],
		[ 'GIT: the commit of the repository', { type: 'GIT', directory: APP_DIRECTORY }, /:git_[0-9a-f]+-[0-9a-f]{40}$/ ]
	];

	it.each(versions)('tags the image with the version of the %s', async function(_description, versioning, tag) {
		const { tree } = await build(`version-${versioning.type}`, directoryOptions({}), versioning);

		expect(builderImageURI(tree)).toMatch(tag);
	});

	it('gives the same FILE tag to two directories with the same files, and another to a directory with other contents', async function() {
		const first = directories.make({ 'Dockerfile': 'FROM scratch', 'a.txt': 'a' });
		const same = directories.make({ 'Dockerfile': 'FROM scratch', 'a.txt': 'a' });
		const other = directories.make({ 'Dockerfile': 'FROM scratch', 'a.txt': 'changed' });
		const tags: string[] = [];
		for (const [ index, directory ] of [ first, same, other ].entries()) {
			const { tree } = await build(`version-files-${index}`, directory, { type: 'FILE', fromFile: directory });
			tags.push(builderImageURI(tree).split(':').pop() ?? '');
		}

		expect(tags[0]).toBe(tags[1]);
		expect(tags[2]).not.toBe(tags[0]);
	});
});

describe('getFileResourceIdentifier', function() {
	const directories = useTempDirectories();

	function makeDirectory(files: { [relativePath: string]: string }) {
		return(directories.make(files));
	}

	it('does not depend on the order files were created in', function() {
		const first = makeDirectory({ 'a.txt': 'a', 'b/c.txt': 'c' });
		const second = makeDirectory({ 'b/c.txt': 'c', 'a.txt': 'a' });

		expect(getFileResourceIdentifier(first)).toBe(getFileResourceIdentifier(second));
	});

	it('changes when a file is renamed or moved', function() {
		const original = makeDirectory({ 'a.txt': 'a', 'b/c.txt': 'c' });
		const renamed = makeDirectory({ 'a.txt': 'a', 'b/d.txt': 'c' });
		const moved = makeDirectory({ 'a.txt': 'a', 'c.txt': 'c' });

		expect(getFileResourceIdentifier(renamed)).not.toBe(getFileResourceIdentifier(original));
		expect(getFileResourceIdentifier(moved)).not.toBe(getFileResourceIdentifier(original));
	});
});
