import { describe, expect, it } from 'vitest';

import type * as apps from '../../src/packages/gcp/apps';
import type * as budget from '../../src/packages/gcp/connection-budget';
import { expectArray, expectDefined, expectRecord, expectString, valueAt } from '../helpers/narrow';
import { requireSource } from './harness/load-sources';
import { ofType, useIsolatedHome } from './harness/pulumi-tree';
import type { TreeSnapshot } from './harness/pulumi-tree';
import { captureService, environmentOf } from './harness/service-builder';
import { captureWarnings } from './harness/warnings';

const { ConnectionBudgetExceededError } = requireSource<typeof budget>('src/packages/gcp/connection-budget.ts');
const { CloudRunServiceArgsError } = requireSource<typeof apps>('src/packages/gcp/apps.ts');

type ServiceArgs = ConstructorParameters<typeof apps.CloudRunService>[1];

const SERVICE_TYPE = 'gcp:cloudrun/service:Service';
const JOB_TYPE = 'gcp:cloudrunv2/job:Job';
const POOL_TYPE = 'gcp:cloudrunv2/workerPool:WorkerPool';
const INSTANCE_TEMPLATE = 'gcp:compute/instanceTemplate:InstanceTemplate';
const SECRET = 'gcp:secretmanager/secret:Secret';
const DATABASE_INSTANCE = 'gcp:sql/databaseInstance:DatabaseInstance';
const MAX_SCALE = 'autoscaling.knative.dev/maxScale';
const POOL_SIZE = 'MC_PSQL_DB_POOL_SIZE';

function annotationsOf(tree: TreeSnapshot) {
	const [ service ] = ofType(tree, SERVICE_TYPE);

	return(expectRecord(valueAt(service?.inputs, [ 'template', 'metadata', 'annotations' ]) ?? {}, 'the annotations of the service'));
}

/** The variables of the container that a virtual machine worker runs: its template holds them in a declaration that is a secret once the database password is in it */
function templateEnvironment(tree: TreeSnapshot) {
	const template = expectDefined(ofType(tree, INSTANCE_TEMPLATE)[0], 'the instance template');
	const declaration = expectString(valueAt(template.revealed, [ 'metadata', 'gce-container-declaration' ]), 'the container declaration');
	const variables = expectArray(valueAt(JSON.parse(declaration), [ 'spec', 'containers', 0, 'env' ]), 'the variables of the container');

	return(Object.fromEntries(variables.map(function(variable) {
		const record = expectRecord(variable, 'a variable of the container');

		return([ String(record.name), record.value ]);
	})));
}

function appWith(extra: Partial<ServiceArgs>): Partial<ServiceArgs> {
	return({ database: {}, ...extra });
}

describe('service.maxInstances', function() {
	useIsolatedHome();

	it('sets the maxScale annotation of the Cloud Run service to the number, as text', async function() {
		const tree = await captureService('scale-given', { service: { maxInstances: 12 }});

		expect(annotationsOf(tree)[MAX_SCALE]).toBe('12');
	});

	it('keeps the annotations of the caller next to it', async function() {
		const tree = await captureService('scale-annotations', { service: { maxInstances: 4, annotations: { 'example.com/team': 'core' }}});

		expect(annotationsOf(tree)).toMatchObject({ [MAX_SCALE]: '4', 'example.com/team': 'core' });
	});

	it('sets no annotation when it is not given', async function() {
		const tree = await captureService('scale-absent', { service: { annotations: { 'example.com/team': 'core' }}});

		expect(Object.keys(annotationsOf(tree))).not.toContain(MAX_SCALE);
	});
});

/*
 * The pool size is an environment variable (the environment of an app
 * is `${name}-env`). The service and the migration job read the app's;
 * the worker reads it too, unless the worker has a pool size of its own,
 * which reaches it through its view override and never through `${name}-env`.
 */
describe('the pool size of a database connection', function() {
	useIsolatedHome();

	it('adds MC_PSQL_DB_POOL_SIZE to the service and the migration job, as a plain value', async function() {
		const tree = await captureService('pool-service', appWith({ migration: { enabled: true }, database: { poolSize: 5 }}));

		expect(environmentOf(tree, SERVICE_TYPE)[POOL_SIZE]).toBe('value:5');
		expect(environmentOf(tree, JOB_TYPE)[POOL_SIZE]).toBe('value:5');
		expect(ofType(tree, SECRET).map(function(secret) {
			return(secret.name);
		}).filter(function(name) {
			return(name.includes('pool-size'));
		})).toEqual([]);
	});

	it('adds no variable when no pool size is given', async function() {
		const tree = await captureService('pool-absent', appWith({ migration: { enabled: true }, worker: { kind: 'crwp' }}));

		expect(Object.keys(environmentOf(tree, SERVICE_TYPE))).not.toContain(POOL_SIZE);
		expect(Object.keys(environmentOf(tree, JOB_TYPE))).not.toContain(POOL_SIZE);
		expect(Object.keys(environmentOf(tree, POOL_TYPE))).not.toContain(POOL_SIZE);
	});

	it('gives a Cloud Run worker pool its own pool size, and the service keeps the one of the database', async function() {
		const tree = await captureService('pool-worker', appWith({ database: { poolSize: 7 }, worker: { kind: 'crwp', poolSize: 13 }}));

		expect(environmentOf(tree, POOL_TYPE)[POOL_SIZE]).toBe('value:13');
		expect(environmentOf(tree, SERVICE_TYPE)[POOL_SIZE]).toBe('value:7');
	});

	it('gives a Cloud Run worker pool the pool size of the database when it has none of its own', async function() {
		const tree = await captureService('pool-inherited', appWith({ database: { poolSize: 7 }, worker: { kind: 'crwp' }}));

		expect(environmentOf(tree, POOL_TYPE)[POOL_SIZE]).toBe('value:7');
	});

	/* The service connects to the database too: a budget that leaves out its share would say "fits" for a sum that is missing its largest term */
	it.each([ 'crwp', 'mig' ] as const)('rejects a %s worker pool size when the database has none, naming both', async function(kind) {
		const result = captureService(`pool-worker-only-${kind}`, appWith({ worker: { kind, poolSize: 9 }}));

		await expect(result).rejects.toBeInstanceOf(CloudRunServiceArgsError);
		await expect(result).rejects.toThrow(/^worker\.poolSize requires database\.poolSize/);
	});

	it('gives a virtual machine worker its own pool size, and not the one of the database', async function() {
		const tree = await captureService('pool-vm', appWith({ database: { poolSize: 7 }, worker: { kind: 'mig', poolSize: 13 }}));

		expect(templateEnvironment(tree)[POOL_SIZE]).toBe('13');
		expect(environmentOf(tree, SERVICE_TYPE)[POOL_SIZE]).toBe('value:7');
	});

	it('keeps the max_connections of the library (25000) when the database has a pool size', async function() {
		const tree = await captureService('pool-flag', appWith({ database: { poolSize: 5 }}));
		const flags = valueAt(expectDefined(ofType(tree, DATABASE_INSTANCE)[0], 'the database instance').inputs, [ 'settings', 'databaseFlags' ]);

		expect(JSON.stringify(flags)).toContain('25000');
	});
});

/*
 * The check: the service (maxInstances x poolSize) and the worker
 * (instanceCount x its poolSize, or the one of the database) must fit in
 * what is available once 10% of max_connections is kept back. Here
 * max_connections is 100: 90 are available. The migration job is not a
 * consumer: it is one task that ends before the service takes traffic.
 */
/* Every rule of the connection arguments, each broken alone */
describe('the connection arguments of a service', function() {
	useIsolatedHome();

	const counts: [ string, Partial<ServiceArgs> ][] = [ 0, 1.5 ].flatMap(function(count): [ string, Partial<ServiceArgs> ][] {
		return([
			[ `service.maxInstances ${count}`, appWith({ service: { maxInstances: count }}) ],
			[ `database.poolSize ${count}`, appWith({ database: { poolSize: count }}) ],
			[ `worker.poolSize ${count}`, appWith({ database: { poolSize: 5 }, worker: { kind: 'crwp', poolSize: count }}) ]
		]);
	});

	it.each(counts)('rejects %s, naming it', async function(name, args) {
		const result = captureService(`args-count-${name.replace(/[^a-z0-9]+/gi, '-')}`, args);

		await expect(result).rejects.toBeInstanceOf(CloudRunServiceArgsError);
		await expect(result).rejects.toThrow(`${name.split(' ')[0]} must be a whole number of 1 or more`);
	});

	const conflicts: [ string, Partial<ServiceArgs>, string ][] = [
		[ 'service.maxInstances with the maxScale annotation', appWith({ service: { maxInstances: 4, annotations: { [MAX_SCALE]: '4' }}}), MAX_SCALE ],
		[ `database.poolSize with ${POOL_SIZE} in environment`, appWith({ database: { poolSize: 5 }, environment: { [POOL_SIZE]: '5' }}), 'so environment cannot set it too' ],
		[ `worker.poolSize with ${POOL_SIZE} in worker.environmentOverrides`, appWith({ database: { poolSize: 5 }, worker: { kind: 'crwp', poolSize: 5, environmentOverrides: { [POOL_SIZE]: '5' }}}), 'so worker.environmentOverrides cannot set it too' ]
	];

	it.each(conflicts)('rejects %s', async function(title, args, message) {
		const result = captureService(`args-conflict-${title.split(' ')[0]?.replace(/\./g, '-')}`, args);

		await expect(result).rejects.toBeInstanceOf(CloudRunServiceArgsError);
		await expect(result).rejects.toThrow(message);
	});
});

describe('the connection budget of a service', function() {
	useIsolatedHome();

	function budgeted(extra: Partial<ServiceArgs>): Partial<ServiceArgs> {
		return({
			migration: { enabled: true },
			database: { flags: { max_connections: 100 }, poolSize: 5 },
			service: { maxInstances: 6 },
			...extra
		});
	}

	/* 6 x 5 = 30 for the service; the worker takes the rest */
	it.each([ 'crwp', 'mig' ] as const)('accepts a %s worker that brings the total to exactly the 90 available', async function(kind) {
		const tree = await captureService(`budget-exact-${kind}`, budgeted({ worker: { kind, instanceCount: 3, poolSize: 20 }}));

		expect(ofType(tree, SERVICE_TYPE)).toHaveLength(1);
	});

	it.each([ 'crwp', 'mig' ] as const)('rejects a %s worker that takes one connection more, with the error of the budget', async function(kind) {
		const result = captureService(`budget-over-${kind}`, budgeted({ worker: { kind, instanceCount: 3, poolSize: 21 }}));

		await expect(result).rejects.toBeInstanceOf(ConnectionBudgetExceededError);
		await expect(result).rejects.toThrow('93');
	});

	it('counts the worker with the pool size of the database when it has none of its own', async function() {
		/* One program at a time: the Pulumi runtime state is process-wide */
		const fits = await captureService('budget-inherit-fits', budgeted({ worker: { kind: 'crwp', instanceCount: 12 }}));

		expect(ofType(fits, SERVICE_TYPE)).toHaveLength(1);
		await expect(captureService('budget-inherit-over', budgeted({ worker: { kind: 'crwp', instanceCount: 13 }}))).rejects.toBeInstanceOf(ConnectionBudgetExceededError);
	});

	it('rejects a service whose instances alone are over the budget', async function() {
		await expect(captureService('budget-service-over', budgeted({ service: { maxInstances: 19 }}))).rejects.toBeInstanceOf(ConnectionBudgetExceededError);
	});

	it('counts a service without maxInstances as the 100 instances that Cloud Run may start, and says so', async function() {
		const result = captureService('budget-no-max-instances', budgeted({ service: {}, database: { flags: { max_connections: 100 }, poolSize: 1 }}));

		await expect(result).rejects.toBeInstanceOf(ConnectionBudgetExceededError);
		await expect(result).rejects.toThrow(/no maxInstances.*100/);
	});

	/* max_connections is 100: 10 are kept in reserve, and the migration job opens a pool while the old revision still serves */
	const migrationPools = [
		{ title: 'warns when the pool of the migration job is larger than the reserve', migration: { enabled: true }, poolSize: 11, warnings: 1 },
		{ title: 'does not warn when the pool is exactly the reserve', migration: { enabled: true }, poolSize: 10, warnings: 0 },
		{ title: 'does not warn when the migration job is not enabled', migration: { enabled: false }, poolSize: 11, warnings: 0 }
	];

	it.each(migrationPools)('$title', async function(testCase) {
		const { warnings } = await captureWarnings(function() {
			return(captureService('budget-migration-reserve', budgeted({ migration: testCase.migration, database: { flags: { max_connections: 100 }, poolSize: testCase.poolSize }, service: { maxInstances: 1 }})));
		});
		const reserve = warnings.filter(function(message) {
			return(message.includes('connections kept in reserve'));
		});

		expect(reserve).toHaveLength(testCase.warnings);
	});

	it('names the pool size and the reserve in the warning about the migration job', async function() {
		const { warnings } = await captureWarnings(function() {
			return(captureService('budget-migration-reserve-text', budgeted({ database: { flags: { max_connections: 100 }, poolSize: 11 }, service: { maxInstances: 1 }})));
		});

		expect(warnings).toContainEqual(expect.stringMatching(/database\.poolSize 11 is more than the 10 connections kept in reserve.*MC_PSQL_DB_POOL_SIZE/));
	});

	it('does not run the check when no pool size is given, however many instances there are', async function() {
		const tree = await captureService('budget-unchecked', {
			database: { flags: { max_connections: 100 }},
			service: { maxInstances: 1000 },
			worker: { kind: 'crwp', instanceCount: 50 }
		});

		expect(ofType(tree, SERVICE_TYPE)).toHaveLength(1);
	});
});
