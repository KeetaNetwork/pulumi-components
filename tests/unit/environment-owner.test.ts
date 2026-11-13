import { describe, expect, it } from 'vitest';

import type * as apps from '../../src/packages/gcp/apps';
import { expectString, optionalRecord } from '../helpers/narrow';
import { matchLegacyUrns, useIsolatedHome } from './harness/pulumi-tree';
import type { TreeResource, TreeSnapshot } from './harness/pulumi-tree';
import { captureService } from './harness/service-builder';


type ServiceArgs = ConstructorParameters<typeof apps.CloudRunService>[1];
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
function argsFor(kind: WorkerKind, extra: Partial<ServiceArgs> = {}): Partial<ServiceArgs> {
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

/** The `envs` of the first container found in the inputs of a resource */
function findEnvs(value: unknown): unknown[] {
	if (Array.isArray(value)) {
		const items: unknown[] = value;
		for (const item of items) {
			const found = findEnvs(item);
			if (found.length > 0) {
				return(found);
			}
		}

		return([]);
	}

	const record = optionalRecord(value);
	if (record === undefined) {
		return([]);
	}

	if (Array.isArray(record.envs)) {
		const envs: unknown[] = record.envs;

		return(envs);
	}

	for (const nested of Object.values(record)) {
		const found = findEnvs(nested);
		if (found.length > 0) {
			return(found);
		}
	}

	return([]);
}

/** What a runtime is given for each variable: `value:<plain>`, or `secret:<name of the secret>` */
function environmentOf(tree: TreeSnapshot, type: string) {
	const resource = tree.resources.find(function(candidate) {
		return(candidate.type === type);
	});
	const described: { [name: string]: string } = {};
	for (const entry of findEnvs(resource?.inputs)) {
		const record = optionalRecord(entry);
		const reference = optionalRecord(optionalRecord(record?.valueFrom ?? record?.valueSource)?.secretKeyRef);
		const secretName = reference?.name ?? reference?.secret;
		const name = expectString(record?.name, 'the name of a variable');
		if (typeof secretName === 'string') {
			described[name] = `secret:${secretName}`;
		} else if (typeof record?.value === 'string') {
			described[name] = `value:${record.value}`;
		}
	}

	return(described);
}

function secretOf(app: string, variable: string) {
	return(`secret:${app}-env-${variable}`);
}

/*
 * An app has one environment. Its secrets are made once, by `${name}-env`,
 * and the service, the migration job and the worker read them.
 */
describe('the environment of an app', function() {
	useIsolatedHome();

	const kinds: [ WorkerKind ][] = [ [ 'mig' ], [ 'crwp' ] ];

	it.each(kinds)('has one EnvManager and one secret, version and binding for each secret variable, with a %s worker', async function(kind) {
		const app = `env-one-${kind}`;
		const tree = await captureService(app, argsFor(kind));
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
		const environment = environmentOf(await captureService(app, argsFor(kind)), SERVICE_TYPE);

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
		const tree = await captureService(app, argsFor(kind));
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

	/* The worker of 1.0.95 had no Redis variables */
	it('gives the Cloud Run worker pool the secrets of the app, the Redis variables and its own overrides only', async function() {
		const app = 'env-pool';
		const environment = environmentOf(await captureService(app, argsFor('crwp')), POOL_TYPE);

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
		const tree = await captureService('env-existing-pool', argsFor('crwp', existing));

		expect(environmentOf(tree, JOB_TYPE).EXISTING).toBe('secret:existing-secret');
		expect(environmentOf(tree, POOL_TYPE).EXISTING).toBe('secret:existing-secret');
		expect(environmentOf(tree, SERVICE_TYPE).EXISTING).toBe('secret:existing-secret');
	});

	it('fails a virtual machine worker that is given a secret the caller owns, naming the variable', async function() {
		await expect(captureService('env-existing-vm', argsFor('mig', existing))).rejects.toThrow('EXISTING');
	});

	/*
	 * The binding of a secret that the caller owns was made once by each of
	 * the three EnvManagers of 1.0.95, for the same secret, account and role.
	 * Deleting two of them removes the binding that the third stands for, so
	 * the two that leave are kept (retained) and the one of the app is live.
	 */
	it('keeps the duplicate bindings of a secret the caller owns retained, never deleted', async function() {
		const app = 'env-bindings';
		const tree = await captureService(app, argsFor('crwp', existing));
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

	/*
	 * GCP holds one binding for a (secret, role, member). The bindings that
	 * leave the stack are kept, so the one that does not is what grants the
	 * access: each retained binding needs a live twin of the same tuple, or a
	 * retained copy would stand alone and deleting it would be a revoke.
	 */
	function bindingTuple(resource: TreeResource) {
		const inputs = optionalRecord(resource.inputs);

		return(JSON.stringify([ inputs?.secretId, inputs?.role, inputs?.member ]));
	}

	const twinApps: [ string, Partial<ServiceArgs> ][] = [
		[ 'a worker pool', argsFor('crwp', existing) ],
		[ 'a migration only', { database: {}, migration: { enabled: true }, environment: existing.environment }]
	];

	it.each(twinApps)('gives each retained binding of a secret the caller owns a live twin, in %s', async function(description, overrides) {
		const tree = await captureService(`env-twin-${description.replace(/[^a-z]+/g, '-')}`, overrides);
		const bindings = tree.resources.filter(function(resource) {
			return(resource.type === SECRET_BINDING && resource.name.includes('-non-managed-'));
		});
		const live = new Set(bindings.filter(function(resource) {
			return(resource.retainOnDelete !== true);
		}).map(bindingTuple));
		const alone = bindings.filter(function(resource) {
			return(resource.retainOnDelete === true && !live.has(bindingTuple(resource)));
		});

		expect(alone.map(function(resource) {
			return(resource.name);
		})).toEqual([]);
	});

	it('keeps retained bindings for the worker pool app, so that the twin check is not empty', async function() {
		const tree = await captureService('env-twin-present', argsFor('crwp', existing));

		expect(tree.resources.filter(function(resource) {
			return(resource.type === SECRET_BINDING && resource.name.includes('-non-managed-') && resource.retainOnDelete === true);
		}).length).toBeGreaterThan(0);
	});
});

/*
 * A virtual machine reads its variables from the metadata of the instance
 * template, and a literal that the caller marked secret has to be a secret
 * there, or it would sit in the state in plain text.
 */
describe('the environment of a virtual machine worker', function() {
	useIsolatedHome();

	const DECLARATION = 'gce-container-declaration';
	const TEMPLATE = 'gcp:compute/instanceTemplate:InstanceTemplate';

	async function declarationOf(name: string, environment: Partial<ServiceArgs>['environment']) {
		const tree = await captureService(name, { environment, worker: { kind: 'mig' }});
		const template = tree.resources.find(function(resource) {
			return(resource.type === TEMPLATE);
		});

		return(optionalRecord(optionalRecord(template?.inputs)?.metadata)?.[DECLARATION]);
	}

	it('keeps the declaration of the container a secret when a variable is a secret literal', async function() {
		expect(await declarationOf('vm-secret-literal', { PLAIN: 'v', TOKEN: { value: 'hidden', secret: true }})).toBe('<secret>');
	});

	it('shows the declaration of the container when no variable is secret', async function() {
		expect(await declarationOf('vm-plain', { PLAIN: 'visible-value' })).toEqual(expect.stringContaining('visible-value'));
	});
});
