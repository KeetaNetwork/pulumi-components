import { describe, expect, it } from 'vitest';

import type * as cloudrunJob from '../../src/packages/gcp/cloudrun-job';
import { requireSource } from './harness/load-sources';

const { executionStateOf, jobExecutionHasChanges } = requireSource<typeof cloudrunJob>('src/packages/gcp/cloudrun-job.ts')._Testing;

const execution = { jobName: 'job-1', projectId: 'project', region: 'us-central1', trigger: 'image@sha256:aaa' };
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

	it('is not a change when the inputs are the same', function() {
		expect(jobExecutionHasChanges(state, { ...execution })).toBe(false);
	});

	it('is a change when the state holds no inputs, as a state from before 2.0 does', function() {
		const stateWithoutInputs: Partial<typeof execution> = {};

		expect(jobExecutionHasChanges(stateWithoutInputs, { ...execution })).toBe(true);
	});
});
