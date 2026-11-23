import { describe, expect, it } from 'vitest';

import type * as localdocker from '../../src/packages/localdocker';
import { requireSource } from './harness/load-sources';

const { pickRepoDigest, localBuildHasChanges } = requireSource<typeof localdocker>('src/packages/localdocker.ts')._Testing;

const SHA_A = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/*
 * `docker image inspect` lists one RepoDigests entry per repository the image
 * was pushed to (or pulled from, as a cache). The digest of the image that was
 * built is the one of the repository in its own URI.
 */
describe('pickRepoDigest', function() {
	const accepted: [ string, string[], string, string ][] = [
		[ 'the only entry', [ `registry.example/project/repo@${SHA_A}` ], 'registry.example/project/repo:tag', `registry.example/project/repo@${SHA_A}` ],
		[
			'the matching entry when an entry of another repository is listed first',
			[ `registry.example/project/cache@${SHA_B}`, `registry.example/project/repo@${SHA_A}` ],
			'registry.example/project/repo:tag',
			`registry.example/project/repo@${SHA_A}`
		],
		[
			'the matching entry when the registry has a port',
			[ `host:5000/other@${SHA_B}`, `host:5000/repo@${SHA_A}` ],
			'host:5000/repo:tag',
			`host:5000/repo@${SHA_A}`
		],
		[
			'the short form docker lists for a docker.io user repository',
			[ `other/cache@${SHA_B}`, `user/img@${SHA_A}` ],
			'docker.io/user/img:tag',
			`user/img@${SHA_A}`
		],
		[
			'the short form docker lists for a docker.io library repository',
			[ `other/cache@${SHA_B}`, `img@${SHA_A}` ],
			'docker.io/library/img:tag',
			`img@${SHA_A}`
		],
		[
			'the first of two entries of the same repository',
			[ `host:5000/repo@${SHA_A}`, `host:5000/repo@${SHA_B}` ],
			'host:5000/repo:tag',
			`host:5000/repo@${SHA_A}`
		]
	];

	it.each(accepted)('returns %s', function(_description, repoDigests, imageURI, expected) {
		expect(pickRepoDigest(repoDigests, imageURI)).toBe(expected);
	});

	const rejected: [ string, string[], string ][] = [
		[ 'there are no entries', [], 'registry.example/project/repo:tag' ],
		[ 'only other repositories are listed', [ `registry.example/project/cache@${SHA_B}` ], 'registry.example/project/repo:tag' ],
		[ 'an entry only starts with the repository (repo-other)', [ `registry.example/project/repo-other@${SHA_B}` ], 'registry.example/project/repo:tag' ],
		[ 'an entry has the same name on another registry port', [ `host:5001/repo@${SHA_B}` ], 'host:5000/repo:tag' ]
	];

	it.each(rejected)('throws when %s', function(_description, repoDigests, imageURI) {
		/* Without this a missing export would make the call below throw and pass for the wrong reason */
		expect(pickRepoDigest).toBeTypeOf('function');
		expect(function() {
			pickRepoDigest(repoDigests, imageURI);
		}).toThrow();
	});
});

/*
 * The directory a build runs in is a fresh temp directory each time, and the
 * secrets are only read by the build. Neither says the image is different.
 */
describe('localBuildHasChanges', function() {
	interface Build {
		imageURI: string;
		buildDirectory: string;
		buildArgs: string[];
		imageCache: string;
		tags: string[];
		secretContents: string;
		cleanBuildDirectory: boolean;
		auth: { project: string; impersonateServiceAccount?: string };
	}

	const build: Build = {
		imageURI: 'registry.example/project/repo:tag',
		buildDirectory: '/tmp/docker-build-aaaaaa',
		buildArgs: [ '--platform', 'linux/amd64' ],
		imageCache: 'registry.example/project/repo:cache',
		tags: [ 'registry.example/project/repo:latest' ],
		secretContents: 'TOKEN=one',
		cleanBuildDirectory: false,
		auth: { project: 'project' }
	};

	const unchanged: [ string, Partial<Build> ][] = [
		[ 'nothing differs', {} ],
		[ 'only the temporary build directory differs', { buildDirectory: '/tmp/docker-build-bbbbbb' } ],
		[ 'only the secret contents differ', { secretContents: 'TOKEN=two' } ],
		[ 'only cleanBuildDirectory differs', { cleanBuildDirectory: true } ],
		[ 'all three of those differ', { buildDirectory: '/tmp/docker-build-bbbbbb', secretContents: 'TOKEN=two', cleanBuildDirectory: true } ],
		[ 'only the auth input differs', { auth: { project: 'other', impersonateServiceAccount: 'deployer@project.iam.gserviceaccount.com' }} ]
	];

	it.each(unchanged)('is not a change when %s', function(_description, overrides) {
		expect(localBuildHasChanges(build, { ...build, ...overrides })).toBe(false);
	});

	const changed: [ string, Partial<Build> ][] = [
		[ 'imageURI', { imageURI: 'registry.example/project/repo:other' } ],
		[ 'buildArgs', { buildArgs: [ '--platform', 'linux/arm64' ] } ],
		[ 'imageCache', { imageCache: 'registry.example/project/repo:other-cache' } ],
		[ 'tags', { tags: [ 'registry.example/project/repo:v2' ] } ],
		[ 'imageURI together with the temporary build directory', { imageURI: 'registry.example/project/repo:other', buildDirectory: '/tmp/docker-build-bbbbbb' } ]
	];

	it.each(changed)('is a change when %s differs', function(_description, overrides) {
		expect(localBuildHasChanges(build, { ...build, ...overrides })).toBe(true);
	});
});
