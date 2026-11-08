import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import type * as apps from '../../src/packages/gcp/apps';
import { expectArray, expectRecord, expectString } from '../helpers/narrow';
import { requireSource } from './harness/load-sources';
import { captureTree, useIsolatedHome } from './harness/pulumi-tree';
import type { TreeSnapshot } from './harness/pulumi-tree';

const { CloudRunService } = requireSource<typeof apps>('src/packages/gcp/apps.ts');

type ServiceArgs = ConstructorParameters<typeof CloudRunService>[1];

const APP_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/app');
const IMAGE = 'us-central1-docker.pkg.dev/project-id/keeta/app:1';

function buildService(name: string, overrides: Partial<ServiceArgs>) {
	return(captureTree(function() {
		return(new CloudRunService(name, { gcp: { project: 'project-id' }, region: 'us-central1', image: { uri: IMAGE }, ...overrides }));
	}));
}

describe('CloudRunService migration', function() {
	const rejected: [ string, Partial<ServiceArgs> ][] = [
		[ 'enabled without a database', { migration: { enabled: true } } ],
		[ 'enabled without a database but with other resources', { migration: { enabled: true }, kv: { type: 'redis', memorySizeGb: 1 } } ]
	];

	it.each(rejected)('throws "migration.enabled requires database" when it is %s', async function(description, overrides) {
		await expect(buildService(`migration-${description.replace(/ /g, '-')}`, overrides)).rejects.toThrow('migration.enabled requires database');
	});

	const accepted: [ string, Partial<ServiceArgs>, number ][] = [
		[ 'enabled with a database', { database: {}, migration: { enabled: true } }, 1 ],
		[ 'disabled without a database', { migration: { enabled: false } }, 0 ],
		[ 'not configured', {}, 0 ],
		[ 'disabled with a database', { database: {}, migration: { enabled: false } }, 0 ]
	];

	it.each(accepted)('accepts it when it is %s', async function(description, overrides, jobs) {
		const tree = await buildService(`migration-ok-${description.replace(/ /g, '-')}`, overrides);
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
		return(buildService(name, {
			image: { build: { directory: APP_DIRECTORY, imageName: name, githubSha: 'sha-1', remote: {}, secrets } }
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
