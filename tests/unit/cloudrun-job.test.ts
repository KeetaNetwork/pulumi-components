import { describe, expect, it } from 'vitest';

import type * as cloudrunJob from '../../src/packages/gcp/cloudrun-job';
import { requireSource } from './harness/load-sources';

const { executionStateOf, jobExecutionHasChanges } = requireSource<typeof cloudrunJob>('src/packages/gcp/cloudrun-job.ts')._Testing;

const execution: { jobName: string; projectId: string; region: string; trigger: string; auth: { project: string; impersonateServiceAccount?: string }} = {
	jobName: 'job-1', projectId: 'project', region: 'us-central1', trigger: 'image@sha256:aaa', auth: { project: 'project' }
};
const output = { executionName: 'execution-1', status: 'CONDITION_SUCCEEDED' as const, createTime: '1', completionTime: '2', logUri: null };

/*
 * `diff` receives the stored state of the execution, which is what `create`
 * and `update` return, so each case compares that state with new inputs.
 */
describe('jobExecutionHasChanges', function() {
	const state = executionStateOf(execution, output);

	const changed: [ string, Partial<typeof execution> ][] = [
		[ 'the trigger', { trigger: 'image@sha256:bbb' } ],
		[ 'the job name', { jobName: 'job-2' } ],
		[ 'the project', { projectId: 'other' } ],
		[ 'the region', { region: 'europe-west1' } ]
	];

	it.each(changed)('is a change when %s differs', function(_description, overrides) {
		expect(jobExecutionHasChanges(state, { ...execution, ...overrides })).toBe(true);
	});

	const unchanged: [ string, Partial<typeof execution> ][] = [
		[ 'nothing differs', {} ],
		[ 'only the auth input differs', { auth: { project: 'other', impersonateServiceAccount: 'deployer@project.iam.gserviceaccount.com' }} ]
	];

	it.each(unchanged)('is not a change when %s', function(_description, overrides) {
		expect(jobExecutionHasChanges(state, { ...execution, ...overrides })).toBe(false);
	});

	it('is a change when the state holds no inputs, as a state from before 2.0 does', function() {
		const stateWithoutInputs: Partial<typeof execution> = {};

		expect(jobExecutionHasChanges(stateWithoutInputs, { ...execution })).toBe(true);
	});
});
