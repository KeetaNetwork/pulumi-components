import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import type * as apps from '../../src/packages/gcp/apps';
import { expectArray, expectRecord, expectString } from '../helpers/narrow';
import { requireSource } from './harness/load-sources';
import { useIsolatedHome } from './harness/pulumi-tree';
import type { TreeSnapshot } from './harness/pulumi-tree';
import { captureService } from './harness/service-builder';

const { CloudRunService } = requireSource<typeof apps>('src/packages/gcp/apps.ts');

type ServiceArgs = ConstructorParameters<typeof CloudRunService>[1];

const APP_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/app');
describe('CloudRunService migration', function() {
	const rejected: [ string, Partial<ServiceArgs> ][] = [
		[ 'enabled without a database', { migration: { enabled: true }} ],
		[ 'enabled without a database but with other resources', { migration: { enabled: true }, kv: { type: 'redis', memorySizeGb: 1 }} ]
	];

	it.each(rejected)('throws "migration.enabled requires database" when it is %s', async function(description, overrides) {
		await expect(captureService(`migration-${description.replace(/ /g, '-')}`, overrides)).rejects.toThrow('migration.enabled requires database');
	});

	const accepted: [ string, Partial<ServiceArgs>, number ][] = [
		[ 'enabled with a database', { database: {}, migration: { enabled: true }}, 1 ],
		[ 'disabled without a database', { migration: { enabled: false }}, 0 ],
		[ 'not configured', {}, 0 ],
		[ 'disabled with a database', { database: {}, migration: { enabled: false }}, 0 ]
	];

	it.each(accepted)('accepts it when it is %s', async function(description, overrides, jobs) {
		const tree = await captureService(`migration-ok-${description.replace(/ /g, '-')}`, overrides);
		const migrationJobs = tree.resources.filter(function(resource) {
			return(resource.type === 'Keeta:GCP:MigrationJob');
		});

		expect(migrationJobs).toHaveLength(jobs);
	});
});

/** The `args` of the step of the Cloud Build that creates the secret file, if the build has one */
function createSecretFileCommand(tree: TreeSnapshot): string | undefined {
	for (const resource of tree.resources) {
		const build = expectRecord(resource.inputs ?? {}, `the inputs of ${resource.name}`).build;
		if (build === undefined) {
			continue;
		}

		for (const step of expectArray(expectRecord(build, 'the build').steps, 'the build steps')) {
			const record = expectRecord(step, 'a build step');
			if (record.id === 'create-secret-file') {
				const args = expectArray(record.args, 'the arguments of create-secret-file');

				return(expectString(args[1], 'the command of create-secret-file'));
			}
		}
	}

	return(undefined);
}

describe('remote build secret file', function() {
	useIsolatedHome();

	function buildRemote(name: string, secrets: { [key: string]: string } | undefined) {
		return(captureService(name, {
			image: { build: { directory: APP_DIRECTORY, imageName: name, githubSha: 'sha-1', remote: {}, secrets }}
		}));
	}

	it('writes the secret with printf so the value is never read as an echo option or expanded twice', async function() {
		const command = createSecretFileCommand(await buildRemote('remote-with-secrets', { TOKEN: 'hidden' }));

		expect(command).toContain(`printf '%s' "$$KEETA_SECRET"`);
		expect(command).toContain('mkdir -p');
		expect(command).not.toContain('echo');
	});

	it('has no secret file step without build secrets', async function() {
		expect(createSecretFileCommand(await buildRemote('remote-without-secrets', undefined))).toBeUndefined();
	});
});

/** The environment entries of the first container of the Cloud Run worker pool */
function workerPoolEnvironment(tree: TreeSnapshot): unknown[] {
	const pool = tree.resources.find(function(resource) {
		return(resource.type === 'gcp:cloudrunv2/workerPool:WorkerPool');
	});
	const template = expectRecord(expectRecord(pool?.inputs, 'the worker pool inputs').template, 'the worker pool template');
	const container = expectRecord(expectArray(template.containers, 'the worker pool containers')[0], 'the worker container');

	return(expectArray(container.envs, 'the worker container environment'));
}

/*
 * A Cloud Run worker pool reads Secret Manager references, a container VM
 * does not. An existing secret therefore works for one kind of worker and
 * not for the other.
 */
describe('CloudRunService worker with an existing secret', function() {
	const environment = { EXISTING: { name: 'existing-secret', version: '3' }};

	it('builds a Cloud Run worker pool whose environment references the secret', async function() {
		const tree = await captureService('worker-crwp-existing-secret', {
			mig: { enabled: true, workerKind: 'crwp' },
			environment
		});

		expect(workerPoolEnvironment(tree)).toContainEqual({
			name: 'EXISTING',
			valueSource: { secretKeyRef: { secret: 'existing-secret', version: '3' }}
		});
	});

	it('throws, naming the variable, for a managed instance group', async function() {
		await expect(captureService('worker-mig-existing-secret', {
			mig: { enabled: true, workerKind: 'mig' },
			environment
		})).rejects.toThrow('EXISTING');
	});

	it('builds a managed instance group when the secret is not in the environment', async function() {
		const tree = await captureService('worker-mig-plain', { mig: { enabled: true, workerKind: 'mig' }, environment: { MODE: 'worker' }});

		expect(tree.resources.some(function(resource) {
			return(resource.type === 'Keeta:GCP:ContainerMIG');
		})).toBe(true);
	});
});
