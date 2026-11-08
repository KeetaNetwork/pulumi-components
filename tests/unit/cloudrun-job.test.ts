import { describe, expect, it } from 'vitest';

import type * as cloudrunJob from '../../src/packages/gcp/cloudrun-job';
import { requireSource } from './harness/load-sources';

const { jobExecutionHasChanges } = requireSource<typeof cloudrunJob>('src/packages/gcp/cloudrun-job.ts')._Testing;

/*
 * An execution runs again when its trigger changes. The project and region
 * are part of the job's identity: when they change, so does `jobName`.
 */
describe('jobExecutionHasChanges', function() {
	const execution: { jobName: string; projectId: string; region: string; trigger: string; auth: { project: string; impersonateServiceAccount?: string }} = {
		jobName: 'job-1', projectId: 'project', region: 'us-central1', trigger: 'image@sha256:aaa', auth: { project: 'project' }
	};

	const changed: [ string, Partial<typeof execution> ][] = [
		[ 'the trigger', { trigger: 'image@sha256:bbb' } ],
		[ 'the job name', { jobName: 'job-2' } ],
		[ 'the trigger and the project', { trigger: 'image@sha256:bbb', projectId: 'other' } ]
	];

	it.each(changed)('is a change when %s differs', function(_description, overrides) {
		expect(jobExecutionHasChanges(execution, { ...execution, ...overrides })).toBe(true);
	});

	const unchanged: [ string, Partial<typeof execution> ][] = [
		[ 'nothing differs', {} ],
		[ 'only the project differs', { projectId: 'other' } ],
		[ 'only the region differs', { region: 'europe-west1' } ],
		[ 'the project and the region differ', { projectId: 'other', region: 'europe-west1' } ],
		[ 'only the auth input differs', { auth: { project: 'other', impersonateServiceAccount: 'deployer@project.iam.gserviceaccount.com' }} ]
	];

	it.each(unchanged)('is not a change when %s', function(_description, overrides) {
		expect(jobExecutionHasChanges(execution, { ...execution, ...overrides })).toBe(false);
	});
});
