import fs from 'node:fs';
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
		const tree = await captureTree(function() {
			return(new LocalDockerImage(name, imageInput(name, buildDirectory, versioning)));
		});

		return({ tree });
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

	/** The tag of the image reference, which holds the version */
	function imageTag(tree: TreeSnapshot): string {
		return(builderImageURI(tree).split(':').pop() ?? '');
	}

	/** The tag of an image built from a directory, before and after one file of it changes */
	async function tagsAroundChange(name: string, files: { [file: string]: string }, changed: string, buildDirectory: (directory: string) => ImageInput['buildDirectory'], versioning: (directory: string) => ImageInput['versioning']) {
		const directory = directories.make(files);
		const before = imageTag((await build(`${name}-before`, buildDirectory(directory), versioning(directory))).tree);
		fs.writeFileSync(path.join(directory, changed), 'changed');
		const after = imageTag((await build(`${name}-after`, buildDirectory(directory), versioning(directory))).tree);

		return({ before, after });
	}

	function fileVersion(directory: string): ImageInput['versioning'] {
		return({ type: 'FILE', fromFile: directory });
	}

	/* What changes the FILE tag: the build context, not the files it leaves out */
	const fileTagRows: [ string, { [file: string]: string }, string, (directory: string) => ImageInput['buildDirectory'], boolean ][] = [
		[ 'keeps the tag when a file in .dockerignore changes', { '.dockerignore': 'skip.log', 'Dockerfile': 'FROM scratch', 'skip.log': 'a' }, 'skip.log', function(directory) {
			return(directory);
		}, false ],
		[ 'keeps the tag when a file in the DIRECTORY excludePatterns changes', { 'Dockerfile': 'FROM scratch', 'skip.txt': 'a' }, 'skip.txt', function(directory) {
			return({ type: 'DIRECTORY', directory, excludePatterns: [ 'skip.txt' ] });
		}, false ],
		[ 'changes the tag when the dockerfilePath file changes, even if .dockerignore lists it', { '.dockerignore': 'build.Dockerfile', 'build.Dockerfile': 'FROM scratch' }, 'build.Dockerfile', function(directory) {
			return({ type: 'DIRECTORY', directory, dockerfilePath: 'build.Dockerfile' });
		}, true ]
	];

	it.each(fileTagRows)('FILE version %s', async function(description, files, changed, buildDirectory, tagChanges) {
		const { before, after } = await tagsAroundChange(`file-tag-${fileTagRows.findIndex(function(row) {
			return(row[0] === description);
		})}`, files, changed, buildDirectory, fileVersion);

		expect(after !== before).toBe(tagChanges);
	});

	it('GIT version ignores the DIRECTORY excludePatterns', async function() {
		const versioning: ImageInput['versioning'] = { type: 'GIT', directory: APP_DIRECTORY };
		const plain = imageTag((await build('git-tag-plain', directoryOptions({}), versioning)).tree);
		const excluding = imageTag((await build('git-tag-excluding', directoryOptions({ excludePatterns: [ 'Dockerfile' ] }), versioning)).tree);

		expect(excluding).toBe(plain);
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
