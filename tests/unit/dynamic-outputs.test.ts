import { beforeAll, describe, expect, it } from 'vitest';
import * as pulumi from '@pulumi/pulumi';

import { requireSource } from './harness/load-sources';

const { LocalDockerImageBuilder } = requireSource<typeof import('../../src/packages/localdocker')>('src/packages/localdocker.ts');
const { CloudBuild } = requireSource<typeof import('../../src/packages/gcp/cloudbuild')>('src/packages/gcp/cloudbuild.ts');
const { CloudRunJobExecution } = requireSource<typeof import('../../src/packages/gcp/cloudrun-job')>('src/packages/gcp/cloudrun-job.ts');

/*
 * The values the engine would return for the outputs of each dynamic
 * resource, keyed by the resource name used below
 */
const engineOutputs: { [resourceName: string]: { [outputName: string]: unknown }} = {
	local: { digest: 'sha256:local' },
	build: {
		status: 'SUCCESS',
		results: { images: [ { name: 'image', digest: 'sha256:remote' } ] },
		logUrl: 'https://logs.example/build',
		statusDetail: 'done'
	},
	job: {
		executionName: 'execution-1',
		status: 'SUCCEEDED',
		createTime: '2026-01-01T00:00:00Z',
		completionTime: '2026-01-01T00:01:00Z',
		logUri: 'https://logs.example/job'
	}
};

function resolveOutput(output: pulumi.Output<unknown>) {
	return(new Promise<unknown>(function(resolve) {
		output.apply(resolve);
	}));
}

/*
 * Pulumi assigns each declared output of a dynamic resource onto the
 * instance while its base constructor runs. A class field emitted by the
 * subclass (ES2022 define semantics) would overwrite it with `undefined`.
 */
describe('dynamic resource outputs', function() {
	beforeAll(async function() {
		await pulumi.runtime.setMocks({
			newResource: function(args) {
				return({
					id: `${args.name}-id`,
					state: { ...args.inputs, ...engineOutputs[args.name] }
				});
			},
			call: function(args) {
				return(args.inputs);
			}
		}, 'project', 'stack', false);
	});

	function expectOutputs(resource: object, names: string[]) {
		for (const name of names) {
			const value: unknown = Reflect.get(resource, name);
			expect(pulumi.Output.isInstance(value), `${name} is an Output`).toBe(true);
		}
	}

	it('LocalDockerImageBuilder.digest is the Output Pulumi assigned', async function() {
		const resource = new LocalDockerImageBuilder('local', {
			buildDirectory: '/tmp/build',
			imageURI: 'registry.example/image:tag'
		});

		expectOutputs(resource, [ 'digest' ]);
		expect(await resolveOutput(resource.digest)).toBe('sha256:local');
	});

	it('CloudBuild outputs are the Outputs Pulumi assigned', async function() {
		const resource = new CloudBuild('build', {
			gcpProvider: { project: pulumi.output('project') },
			build: { images: [ 'registry.example/image:tag' ] }
		});

		expectOutputs(resource, [ 'status', 'results', 'logUrl', 'statusDetail', 'build', 'projectId' ]);
		expect(await resolveOutput(resource.status)).toBe('SUCCESS');
		expect(await resolveOutput(resource.results)).toEqual(engineOutputs['build']?.['results']);
		expect(await resolveOutput(resource.logUrl)).toBe('https://logs.example/build');
		expect(await resolveOutput(resource.statusDetail)).toBe('done');
		expect(await resolveOutput(resource.build)).toEqual({ images: [ 'registry.example/image:tag' ] });
		expect(await resolveOutput(resource.projectId)).toBe('project');
	});

	it('CloudRunJobExecution outputs are the Outputs Pulumi assigned', async function() {
		const resource = new CloudRunJobExecution('job', {
			jobName: 'job',
			projectId: 'project',
			region: 'us-central1',
			trigger: 'trigger-1'
		});

		expectOutputs(resource, [ 'executionName', 'status', 'createTime', 'completionTime', 'logUri' ]);
		expect(await resolveOutput(resource.executionName)).toBe('execution-1');
		expect(await resolveOutput(resource.status)).toBe('SUCCEEDED');
		expect(await resolveOutput(resource.createTime)).toBe('2026-01-01T00:00:00Z');
		expect(await resolveOutput(resource.completionTime)).toBe('2026-01-01T00:01:00Z');
		expect(await resolveOutput(resource.logUri)).toBe('https://logs.example/job');
	});
});
