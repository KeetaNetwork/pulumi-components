import { describe, expect, it } from 'vitest';

import { _Testing } from '../../src/packages/gcp/cloudbuild';

const { cloudBuildHasChanges } = _Testing;

describe('cloudBuildHasChanges', function() {
	const build = {
		images: [ 'us-docker.pkg.dev/project/repo/image:hash_abc' ],
		source: { storageSource: { bucket: 'bucket', object: 'image/hash_abc.tar.gz' }}
	};

	it('ignores the secret value and local tarball path', function() {
		const olds = { build, projectId: 'project' };
		const news = {
			build: structuredClone(build),
			projectId: 'project',
			temporarySecret: { secretId: 'temporary-delete-me-build-secret-1234', input: 'GITHUB_TOKEN=other-user' },
			sourceUpload: { bucket: 'bucket', object: 'image/hash_abc.tar.gz', path: '/Users/other/.cache/pulumi-tarballs/x.tar.gz' }
		};

		expect(cloudBuildHasChanges(olds, news)).toBe(false);
	});

	it('ignores the auth input', function() {
		const news = { build, projectId: 'project', auth: { project: 'other', impersonateServiceAccount: 'deployer@project.iam.gserviceaccount.com' }};

		expect(cloudBuildHasChanges({ build, projectId: 'project', auth: { project: 'project' }}, news)).toBe(false);
	});

	it('detects a change to the build definition', function() {
		const news = structuredClone(build);
		news.images = [ 'us-docker.pkg.dev/project/repo/image:hash_def' ];

		expect(cloudBuildHasChanges({ build, projectId: 'project' }, { build: news, projectId: 'project' })).toBe(true);
	});

	it('detects a change of project', function() {
		expect(cloudBuildHasChanges({ build, projectId: 'project' }, { build, projectId: 'other' })).toBe(true);
	});
});
