import * as pulumi from '@pulumi/pulumi';
import { describe, expect, it } from 'vitest';

import type * as apps from '../../src/packages/gcp/apps';
import type * as budget from '../../src/packages/gcp/connection-budget';
import { expectArray, expectDefined, expectRecord, expectString, valueAt } from '../helpers/narrow';
import { requireSource } from './harness/load-sources';
import { ofType, useIsolatedHome } from './harness/pulumi-tree';
import type { TreeSnapshot } from './harness/pulumi-tree';
import { annotationsOf, captureService, databaseInput, environmentOf } from './harness/service-builder';

const { ConnectionBudgetExceededError } = requireSource<typeof budget>('src/packages/gcp/connection-budget.ts');
const { CloudRunServiceArgsError } = requireSource<typeof apps>('src/packages/gcp/apps.ts');

type ServiceArgs = ConstructorParameters<typeof apps.CloudRunService>[1];

const SERVICE_TYPE = 'gcp:cloudrun/service:Service';
const JOB_TYPE = 'gcp:cloudrunv2/job:Job';
const POOL_TYPE = 'gcp:cloudrunv2/workerPool:WorkerPool';
const INSTANCE_TEMPLATE = 'gcp:compute/instanceTemplate:InstanceTemplate';
const SECRET = 'gcp:secretmanager/secret:Secret';
const MAX_SCALE = 'autoscaling.knative.dev/maxScale';
const POOL_SIZE = 'MC_PSQL_DB_POOL_SIZE';

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
 * The pool size is an environment variable (P9: the environment of an app
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
		expect(JSON.stringify(databaseInput(tree, [ 'settings', 'databaseFlags' ]))).toContain('25000');
	});
});

/*
 * The check: the service (maxInstances x poolSize) and the worker
 * (instanceCount x its poolSize, or the one of the database) must fit in
 * what is available once 10% of max_connections is kept back. Here
 * max_connections is 100: 90 are available. The migration job is not a
 * consumer: it is one task that ends before the service takes traffic.
 */
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

	/* The annotation of 1.0.95 caps scaling too: a plain whole number counts as maxInstances, anything else as the 100 that Cloud Run scales to */
	const scales: { title: string; annotations: { [key: string]: pulumi.Input<string> }; fits: boolean }[] = [
		{ title: 'counts a maxScale annotation of 6 as 6 instances, and fits', annotations: { [MAX_SCALE]: '6' }, fits: true },
		{ title: 'counts a maxScale annotation of 7 as 7 instances, and rejects', annotations: { [MAX_SCALE]: '7' }, fits: false },
		{ title: 'counts an annotation that is not a plain number as 100 instances, and rejects', annotations: { [MAX_SCALE]: '6.5' }, fits: false },
		{ title: 'counts an annotation that is an Output as 100 instances, and rejects', annotations: { [MAX_SCALE]: pulumi.output('6') }, fits: false },
		{ title: 'counts a service with neither as 100 instances, and rejects', annotations: {}, fits: false }
	];

	it.each(scales)('$title', async function(row) {
		const built = captureService('budget-annotation', budgeted({ service: { annotations: row.annotations }, worker: { kind: 'crwp', instanceCount: 3, poolSize: 20 }}));

		if (row.fits) {
			expect(annotationsOf(await built)[MAX_SCALE]).toBe('6');
		} else {
			await expect(built).rejects.toBeInstanceOf(ConnectionBudgetExceededError);
		}
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
