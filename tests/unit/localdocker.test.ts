import { describe, expect, it } from 'vitest';

import type * as localdocker from '../../src/packages/localdocker';
import { requireSource } from './harness/load-sources';

const { pickRepoDigest } = requireSource<typeof localdocker>('src/packages/localdocker.ts');

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
