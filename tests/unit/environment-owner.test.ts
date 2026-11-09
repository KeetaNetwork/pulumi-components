import { describe, expect, it } from 'vitest';

import type * as apps from '../../src/packages/gcp/apps';
import { optionalRecord } from '../helpers/narrow';
import { requireSource } from './harness/load-sources';
import { matchLegacyUrns, useIsolatedHome } from './harness/pulumi-tree';
import type { TreeResource, TreeSnapshot } from './harness/pulumi-tree';
import { captureService, environmentOf } from './harness/service-builder';

const { CloudRunService } = requireSource<typeof apps>('src/packages/gcp/apps.ts');

type ServiceArgs = ConstructorParameters<typeof CloudRunService>[1];
type WorkerKind = 'mig' | 'crwp';

const SECRET = 'gcp:secretmanager/secret:Secret';
const SECRET_VERSION = 'gcp:secretmanager/secretVersion:SecretVersion';
const SECRET_BINDING = 'gcp:secretmanager/secretIamMember:SecretIamMember';
const ENV_MANAGER = 'Keeta:GCP:CloudRunEnvManager';
const SERVICE_TYPE = 'gcp:cloudrun/service:Service';
const JOB_TYPE = 'gcp:cloudrunv2/job:Job';
const POOL_TYPE = 'gcp:cloudrunv2/workerPool:WorkerPool';

const SECRET_VARIABLES = [ 'mc-psql-db-password', 'mc-psql-db-url', 'mc-redis-password', 'secret' ];

/** An app with everything that has an environment: a database, Redis, a migration and a worker, each with its own overrides */
function appOf(kind: WorkerKind, extra: Partial<ServiceArgs> = {}): Partial<ServiceArgs> {
	return({
		database: {},
		kv: { type: 'redis', memorySizeGb: 1 },
		migration: { enabled: true, environmentOverrides: { M: 'm' }},
		environment: { PLAIN: 'v', SECRET: { value: 'hidden', secret: true }},
		worker: { kind, environmentOverrides: { W: 'w' }},
		...extra
	});
}

function namesOfType(tree: TreeSnapshot, type: string) {
	return(tree.resources.filter(function(resource) {
		return(resource.type === type);
	}).map(function(resource) {
		return(resource.name);
	}).sort());
}

function secretOf(app: string, variable: string) {
	return(`secret:${app}-env-${variable}`);
}

/*
 * An app has one environment. Its secrets are made once, by `${name}-env`,
 * and the service, the migration job and the worker read them (P9).
 */
describe('the environment of an app', function() {
	useIsolatedHome();

	const kinds: [ WorkerKind ][] = [ [ 'mig' ], [ 'crwp' ] ];

	it.each(kinds)('has one EnvManager and one secret, version and binding for each secret variable, with a %s worker', async function(kind) {
		const app = `env-one-${kind}`;
		const tree = await captureService(app, appOf(kind));
		const secrets = SECRET_VARIABLES.map(function(variable) {
			return(`${app}-env-${variable}`);
		});

		expect(namesOfType(tree, ENV_MANAGER)).toEqual([ `${app}-env` ]);
		expect(namesOfType(tree, SECRET)).toEqual(secrets);
		expect(namesOfType(tree, SECRET_VERSION)).toEqual(secrets.map(function(name) {
			return(`${name}-version`);
		}));
		expect(namesOfType(tree, SECRET_BINDING)).toEqual(secrets.map(function(name) {
			return(`${name}-iam-binding`);
		}));
	});

	it.each(kinds)('gives the service the secrets of the app, and no override of the migration or of the worker, with a %s worker', async function(kind) {
		const app = `env-service-${kind}`;
		const environment = environmentOf(await captureService(app, appOf(kind)), SERVICE_TYPE);

		expect(environment).toMatchObject({
			MC_PSQL_DB_PASSWORD: secretOf(app, 'mc-psql-db-password'),
			MC_REDIS_PASSWORD: secretOf(app, 'mc-redis-password'),
			SECRET: secretOf(app, 'secret'),
			PLAIN: 'value:v'
		});
		expect(Object.keys(environment)).not.toContain('M');
		expect(Object.keys(environment)).not.toContain('W');
	});

	it.each(kinds)('gives the migration job the secrets of the app and its own overrides only, with a %s worker', async function(kind) {
		const app = `env-job-${kind}`;
		const tree = await captureService(app, appOf(kind));
		const environment = environmentOf(tree, JOB_TYPE);

		expect(environment).toMatchObject({
			MC_PSQL_DB_PASSWORD: secretOf(app, 'mc-psql-db-password'),
			MC_PSQL_DB_URL: secretOf(app, 'mc-psql-db-url'),
			SECRET: secretOf(app, 'secret'),
			PLAIN: 'value:v',
			M: 'value:m'
		});
		expect(environment.MC_PSQL_DB_HOST).toBe(environmentOf(tree, SERVICE_TYPE).MC_PSQL_DB_HOST);
		expect(Object.keys(environment)).not.toContain('W');
	});

	/* The worker of 1.0.95 had no Redis variables (B6) */
	it('gives the Cloud Run worker pool the secrets of the app, the Redis variables and its own overrides only', async function() {
		const app = 'env-pool';
		const environment = environmentOf(await captureService(app, appOf('crwp')), POOL_TYPE);

		expect(environment).toMatchObject({
			MC_PSQL_DB_PASSWORD: secretOf(app, 'mc-psql-db-password'),
			MC_PSQL_DB_URL: secretOf(app, 'mc-psql-db-url'),
			MC_REDIS_PASSWORD: secretOf(app, 'mc-redis-password'),
			SECRET: secretOf(app, 'secret'),
			PLAIN: 'value:v',
			W: 'value:w'
		});
		expect(Object.keys(environment)).toContain('MC_REDIS_URL');
		expect(Object.keys(environment)).not.toContain('M');
	});

	/*
	 * The virtual machine reads plain values (`resolvedForVm`), which a Cloud
	 * Run runtime never does: an existing secret fails the machine, not the
	 * job or the pool.
	 */
	const existing: Partial<ServiceArgs> = { environment: { EXISTING: { name: 'existing-secret', version: '3' }}};

	it('lets the migration job and the Cloud Run worker pool read a secret that the caller owns', async function() {
		const tree = await captureService('env-existing-pool', appOf('crwp', existing));

		expect(environmentOf(tree, JOB_TYPE).EXISTING).toBe('secret:existing-secret');
		expect(environmentOf(tree, POOL_TYPE).EXISTING).toBe('secret:existing-secret');
		expect(environmentOf(tree, SERVICE_TYPE).EXISTING).toBe('secret:existing-secret');
	});

	it('fails a virtual machine worker that is given a secret the caller owns, naming the variable', async function() {
		await expect(captureService('env-existing-vm', appOf('mig', existing))).rejects.toThrow('EXISTING');
	});

	/*
	 * The binding of a secret that the caller owns was made once by each of
	 * the three EnvManagers of 1.0.95, for the same secret, account and role.
	 * Deleting two of them removes the binding that the third stands for, so
	 * the two that leave are kept (retained) and the one of the app is live.
	 */
	it('keeps the duplicate bindings of a secret the caller owns retained, never deleted', async function() {
		const app = 'env-bindings';
		const tree = await captureService(app, appOf('crwp', existing));
		const binding = function(parents: string, name: string) {
			return(`urn:pulumi:${tree.stack}::${tree.project}::Keeta:GCP:CloudRunService$${parents}${SECRET_BINDING}::${app}-${name}-non-managed-existing-iam-binding`);
		};
		const duplicates = [
			binding(`${ENV_MANAGER}$`, 'mig-env'),
			binding(`Keeta:GCP:MigrationJob$${ENV_MANAGER}$`, 'migration-env')
		];
		const bindings = tree.resources.filter(function(resource) {
			return(resource.type === SECRET_BINDING && optionalRecord(resource.inputs)?.secretId === 'existing-secret');
		});
		const live = bindings.filter(function(resource: TreeResource) {
			return(resource.retainOnDelete !== true);
		});

		expect((await matchLegacyUrns(tree, duplicates)).unmatched).toEqual([]);
		expect(live.map(function(resource) {
			return(resource.name);
		})).toEqual([ `${app}-env-non-managed-existing-iam-binding` ]);
	});
});
