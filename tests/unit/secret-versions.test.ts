import { describe, expect, it } from 'vitest';

import type * as migration from '../../src/packages/gcp/migration';
import { expectArray, expectRecord } from '../helpers/narrow';
import { requireSource } from './harness/load-sources';
import { captureTree } from './harness/pulumi-tree';
import type { TreeSnapshot } from './harness/pulumi-tree';
import { IMAGE, buildService } from './harness/service-builder';

const { MigrationJob } = requireSource<typeof migration>('src/packages/gcp/migration.ts');

const SECRET_VERSION = 'gcp:secretmanager/secretVersion:SecretVersion';

/** A secret variable, a plain variable, and a reference to a secret somebody else owns */
function environment(secretValue: string) {
	return({
		API_TOKEN: { value: secretValue, secret: true },
		MODE: 'plain',
		EXISTING: { name: 'existing-secret', version: '3' }
	});
}

/** A deployed component that reads a secret variable, and where its environment ends up */
interface SecretPath {
	description: string;
	build: (name: string, secretValue: string) => unknown;
	/** The environment entries and the field of one that carries the secret's version */
	environmentOf: (tree: TreeSnapshot) => unknown[];
	versionOf: (entry: unknown) => unknown;
}

function resourceInputs(tree: TreeSnapshot, type: string) {
	const resource = tree.resources.find(function(candidate) {
		return(candidate.type === type);
	});

	return(expectRecord(resource?.inputs, `the inputs of ${type}`));
}

function firstContainerEnvironment(container: unknown): unknown[] {
	return(expectArray(expectRecord(container, 'a container').envs, 'the container environment'));
}

function secretKeyRef(entry: unknown, field: string) {
	return(expectRecord(expectRecord(entry, 'an environment entry')[field], `the ${field} of an environment entry`).secretKeyRef);
}

const paths: SecretPath[] = [
	{
		description: 'a Cloud Run service',
		build: function(name, secretValue) {
			return(buildService(name, { environment: environment(secretValue) }));
		},
		environmentOf: function(tree) {
			const spec = expectRecord(expectRecord(resourceInputs(tree, 'gcp:cloudrun/service:Service').template, 'the service template').spec, 'the service spec');

			return(firstContainerEnvironment(expectArray(spec.containers, 'the service containers')[0]));
		},
		versionOf: function(entry) {
			return(expectRecord(secretKeyRef(entry, 'valueFrom'), 'the secret reference').key);
		}
	},
	{
		description: 'a migration job',
		build: function(name, secretValue) {
			return(new MigrationJob(name, {
				gcp: { project: 'project-id' },
				region: 'us-central1',
				database: { host: '10.0.0.5', caCertificate: 'certificate', username: 'user', password: 'password', databaseName: 'database' },
				image: IMAGE,
				environment: environment(secretValue)
			}));
		},
		environmentOf: function(tree) {
			const template = expectRecord(expectRecord(resourceInputs(tree, 'gcp:cloudrunv2/job:Job').template, 'the job template').template, 'the job task template');

			return(firstContainerEnvironment(expectArray(template.containers, 'the job containers')[0]));
		},
		versionOf: function(entry) {
			return(expectRecord(secretKeyRef(entry, 'valueSource'), 'the secret reference').version);
		}
	},
	{
		description: 'a Cloud Run worker pool',
		build: function(name, secretValue) {
			return(buildService(name, { mig: { enabled: true, workerKind: 'crwp' }, environment: environment(secretValue) }));
		},
		environmentOf: function(tree) {
			const template = expectRecord(resourceInputs(tree, 'gcp:cloudrunv2/workerPool:WorkerPool').template, 'the worker pool template');

			return(firstContainerEnvironment(expectArray(template.containers, 'the worker pool containers')[0]));
		},
		versionOf: function(entry) {
			return(expectRecord(secretKeyRef(entry, 'valueSource'), 'the secret reference').version);
		}
	}
];

function entryNamed(path: SecretPath, tree: TreeSnapshot, variable: string) {
	return(path.environmentOf(tree).find(function(entry) {
		return(expectRecord(entry, 'an environment entry').name === variable);
	}));
}

function secretVersions(tree: TreeSnapshot) {
	return(tree.resources.filter(function(resource) {
		return(resource.type === SECRET_VERSION);
	}));
}

describe('secret variables roll out with their version', function() {
	let counter = 0;

	/** Builds the path with a new name, because resource names are unique within a stack */
	function capture(path: SecretPath, secretValue: string) {
		counter++;

		return(captureTree(function() {
			return(path.build(`secret-versions-${counter}`, secretValue));
		}));
	}

	describe.each(paths)('in $description', function(path) {
		it('keeps the version the caller named for an existing secret', async function() {
			const tree = await capture(path, 'one');

			expect(path.versionOf(entryNamed(path, tree, 'EXISTING'))).toBe('3');
		});

		it('leaves a plain variable as a value, with no secret version behind it', async function() {
			const tree = await capture(path, 'one');

			expect(entryNamed(path, tree, 'MODE')).toEqual({ name: 'MODE', value: 'plain' });
			expect(secretVersions(tree).map(function(version) {
				return(version.name);
			}).filter(function(name) {
				return(name.includes('mode'));
			})).toEqual([]);
		});

		it('disables a superseded version', async function() {
			const versions = secretVersions(await capture(path, 'one'));

			expect(versions.length).toBeGreaterThan(0);
			expect(versions.map(function(version) {
				return({ policy: expectRecord(version.inputs, 'the version inputs').deletionPolicy, retainOnDelete: version.retainOnDelete });
			})).toEqual(versions.map(function() {
				return({ policy: 'DISABLE', retainOnDelete: undefined });
			}));
		});
	});
});
