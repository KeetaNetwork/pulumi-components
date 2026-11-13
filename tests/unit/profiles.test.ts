import * as pulumi from '@pulumi/pulumi';
import { describe, expect, it } from 'vitest';

import type * as apps from '../../src/packages/gcp/apps';
import type * as budget from '../../src/packages/gcp/connection-budget';
import type * as index from '../../src/packages/gcp/index';
import type * as profileModule from '../../src/packages/gcp/profiles';
import { requireSource } from './harness/load-sources';
import { optionalRecord } from '../helpers/narrow';
import { captureTree, describeTree, ofType, useIsolatedHome } from './harness/pulumi-tree';
import type { TreeSnapshot } from './harness/pulumi-tree';
import { annotationsOf, captureService, databaseInput, environmentOf, flagsOf } from './harness/service-builder';

const { resolveProfile, profiles } = requireSource<typeof profileModule>('src/packages/gcp/profiles.ts');
const { CloudRunServiceArgsError, FullStackApp } = requireSource<typeof apps>('src/packages/gcp/apps.ts');
const { connectionBudget, ConnectionBudgetExceededError } = requireSource<typeof budget>('src/packages/gcp/connection-budget.ts');
const gcpIndex = requireSource<typeof index>('src/packages/gcp/index.ts');

type ServiceArgs = ConstructorParameters<typeof apps.CloudRunService>[1];

const ENVIRONMENTS = [ 'development', 'test', 'production' ] as const;
const SIZES = [ 'small', 'medium', 'large' ] as const;

interface Profile {
	environment: typeof ENVIRONMENTS[number];
	size: typeof SIZES[number];
}

const SERVICE_TYPE = 'gcp:cloudrun/service:Service';
const POOL_TYPE = 'gcp:cloudrunv2/workerPool:WorkerPool';
const MAX_SCALE = 'autoscaling.knative.dev/maxScale';
const POOL_SIZE = 'MC_PSQL_DB_POOL_SIZE';

const ALL_PROFILES = ENVIRONMENTS.flatMap(function(environment) {
	return(SIZES.map(function(size): Profile {
		return({ environment, size });
	}));
});

/** An app that a profile can apply to: it has a database and a Cloud Run worker pool, which is where the profile's numbers go */
function profiled(name: string, extra: Partial<ServiceArgs>) {
	return(captureService(name, { database: {}, worker: { kind: 'crwp' }, ...extra }));
}

/*
 * The numbers of the size axis. Each size fills or fits the connections that
 * its max_connections leaves after the reserve: small 12 x 5 + 7 = 67 of 67,
 * medium 12 x 10 + 16 = 136 of 139, large 70 x 10 + 64 = 764 of 765.
 */
const SIZE_TABLE = [
	{ size: 'small', tier: 'db-g1-small', connections: [ 60, 75 ], maxInstances: 12, webPool: 5, workerPool: 7 },
	{ size: 'medium', tier: 'db-custom-1-3840', connections: [ 140, 170 ], maxInstances: 12, webPool: 10, workerPool: 16 },
	{ size: 'large', tier: 'db-custom-4-15360', connections: [ 750, 900 ], maxInstances: 70, webPool: 10, workerPool: 64 }
] as const;

describe('resolveProfile', function() {
	it.each(SIZE_TABLE)('gives the $size size the numbers of the issue, in every environment', function(row) {
		for (const environment of ENVIRONMENTS) {
			const values = resolveProfile({ environment, size: row.size });
			const connections = values.database.flags?.max_connections ?? 0;

			expect(values.database.tier).toBe(row.tier);
			expect(connections).toBeGreaterThanOrEqual(row.connections[0]);
			expect(connections).toBeLessThanOrEqual(row.connections[1]);
			expect(values.service.maxInstances).toBe(row.maxInstances);
			expect(values.database.poolSize).toBe(row.webPool);
			expect(values.worker.poolSize).toBe(row.workerPool);
		}
	});

	it.each(SIZES)('keeps the environment axis out of the %s size: the numbers do not change with the environment', function(size) {
		const [ development, ...others ] = ENVIRONMENTS.map(function(environment) {
			const values = resolveProfile({ environment, size });

			return({ tier: values.database.tier, connections: values.database.flags?.max_connections, instances: values.service.maxInstances, pools: [ values.database.poolSize, values.worker.poolSize ] });
		});

		for (const other of others) {
			expect(other).toEqual(development);
		}
	});

	it('protects a production database from deletion and a development one not', function() {
		expect(resolveProfile({ environment: 'production', size: 'small' }).database.deletionProtection).toBe(true);
		expect(resolveProfile({ environment: 'development', size: 'small' }).database.deletionProtection).toBe(false);
	});

	it.each(ALL_PROFILES)('is pure: $environment $size gives equal values on every call', function(profile) {
		expect(resolveProfile(profile)).toEqual(resolveProfile({ ...profile }));
	});

	it.each(ALL_PROFILES)('is what the profiles export holds for $environment $size', function(profile) {
		expect(profiles[profile.environment][profile.size]).toEqual(resolveProfile(profile));
	});

	it('is reachable from the index of the package', function() {
		expect(gcpIndex.profiles).toBeDefined();
	});
});

describe('a service with a profile', function() {
	useIsolatedHome();

	function sizeRead(tree: TreeSnapshot) {
		return({
			tier: databaseInput(tree, [ 'settings', 'tier' ]),
			connections: Number(flagsOf(tree).max_connections),
			maxInstances: annotationsOf(tree)[MAX_SCALE],
			webPool: environmentOf(tree, SERVICE_TYPE)[POOL_SIZE],
			workerPool: environmentOf(tree, POOL_TYPE)[POOL_SIZE]
		});
	}

	it.each(SIZE_TABLE)('gets the $size numbers of the issue: tier, max_connections, instances and pool sizes', async function(row) {
		const read = sizeRead(await profiled(`profile-size-${row.size}`, { profile: { environment: 'test', size: row.size }}));

		expect(read).toMatchObject({ tier: row.tier, maxInstances: String(row.maxInstances), webPool: `value:${row.webPool}`, workerPool: `value:${row.workerPool}` });
		expect(read.connections).toBeGreaterThanOrEqual(row.connections[0]);
		expect(read.connections).toBeLessThanOrEqual(row.connections[1]);
	});

	/* Every preset is within its own budget: building it runs the connection budget check */
	it.each(ALL_PROFILES)('builds the $environment $size preset, which fits its own connection budget', async function(profile) {
		const tree = await profiled(`profile-fits-${profile.environment}-${profile.size}`, { profile });

		expect(ofType(tree, SERVICE_TYPE)).toHaveLength(1);
	});

	const production: Profile = { environment: 'production', size: 'small' };

	interface Layer {
		field: string;
		explicit: Partial<ServiceArgs>;
		read: (tree: TreeSnapshot) => unknown;
		whenExplicit: unknown;
		whenDefault: unknown;
	}

	/* An explicit argument beats the profile, which beats the default: three trees for each argument the profile sets */
	const layers: Layer[] = [
		{ field: 'database.tier', explicit: { database: { tier: 'db-custom-2-7680' }}, read: function(tree) {
			return(databaseInput(tree, [ 'settings', 'tier' ]));
		}, whenExplicit: 'db-custom-2-7680', whenDefault: 'db-f1-micro' },
		{ field: 'database.flags.max_connections', explicit: { database: { flags: { max_connections: 200 }}}, read: function(tree) {
			return(flagsOf(tree).max_connections);
		}, whenExplicit: '200', whenDefault: '25000' },
		{ field: 'database.deletionProtection', explicit: { database: { deletionProtection: false }}, read: function(tree) {
			return(databaseInput(tree, [ 'deletionProtection' ]));
		}, whenExplicit: false, whenDefault: false },
		{ field: 'service.maxInstances', explicit: { service: { maxInstances: 3 }}, read: function(tree) {
			return(annotationsOf(tree)[MAX_SCALE]);
		}, whenExplicit: '3', whenDefault: undefined },
		{ field: 'database.poolSize', explicit: { database: { poolSize: 4 }}, read: function(tree) {
			return(environmentOf(tree, SERVICE_TYPE)[POOL_SIZE]);
		}, whenExplicit: 'value:4', whenDefault: undefined },
		{ field: 'worker.poolSize', explicit: { worker: { kind: 'crwp', poolSize: 6 }}, read: function(tree) {
			return(environmentOf(tree, POOL_TYPE)[POOL_SIZE]);
		}, whenExplicit: 'value:6', whenDefault: undefined }
	];

	it.each(layers)('takes $field from the argument, else from the profile, else from the default', async function(layer) {
		const withProfile = layer.read(await profiled('layer-profile', { profile: production }));
		const withExplicit = layer.read(await profiled('layer-explicit', { profile: production, ...layer.explicit }));
		const withDefault = layer.read(await profiled('layer-default', {}));

		expect(withExplicit).toEqual(layer.whenExplicit);
		expect(withDefault).toEqual(layer.whenDefault);
		expect(withProfile).not.toEqual(layer.whenExplicit);
		expect(withProfile).not.toEqual(layer.whenDefault);
	});

	/*
	 * On the size axis the tier and its max_connections go together: a tier
	 * of the caller brings the default of that tier, not the profile's.
	 */
	const tiers = [
		{ size: 'small', tier: 'db-custom-1-3840', connections: '100' },
		{ size: 'small', tier: 'db-custom-2-7680', connections: '400' },
		{ size: 'medium', tier: 'db-custom-2-7680', connections: '400' }
	] as const;

	it.each(tiers)('writes max_connections $connections, the default of $tier, for the $size profile with that tier', async function(row) {
		const tree = await profiled(`tier-brings-${row.size}-${row.tier}`, { profile: { environment: 'test', size: row.size }, database: { tier: row.tier }});

		expect(flagsOf(tree).max_connections).toBe(row.connections);
	});

	it('keeps the max_connections of the caller with a tier of the caller', async function() {
		const tree = await profiled('tier-and-flag', { profile: { environment: 'test', size: 'small' }, database: { tier: 'db-custom-1-3840', flags: { max_connections: 120 }}});

		expect(flagsOf(tree).max_connections).toBe('120');
	});

	/* The pools of the profile do not fit what these tiers hold (25 and 400), and the check says so */
	it.each([ { size: 'small', tier: 'db-f1-micro' }, { size: 'large', tier: 'db-custom-2-7680' } ] as const)('rejects the $size profile with $tier, which cannot hold its pools', async function(row) {
		const built = profiled(`tier-too-small-${row.size}`, { profile: { environment: 'test', size: row.size }, database: { tier: row.tier }});

		await expect(built).rejects.toBeInstanceOf(ConnectionBudgetExceededError);
	});

	it('rejects a tier the profile does not know unless the caller gives max_connections', async function() {
		const profile = { environment: 'test', size: 'small' } as const;
		const built = profiled('tier-unknown', { profile, database: { tier: 'db-mystery-8' }});

		await expect(built).rejects.toBeInstanceOf(CloudRunServiceArgsError);
		await expect(built).rejects.toThrow(/database\.tier.*max_connections/);

		const tree = await profiled('tier-unknown-flag', { profile, database: { tier: 'db-mystery-8', flags: { max_connections: 300 }}});

		expect(flagsOf(tree).max_connections).toBe('300');
	});

	/*
	 * A caller who caps scaling with the annotation of 1.0.95 keeps it with a
	 * profile, and the budget counts it as the number of instances (a plain
	 * whole number: an Output is not known, so Cloud Run's 100 count).
	 */
	it('keeps the maxScale annotation of the caller with a profile, and builds at that scale', async function() {
		const annotations = { [MAX_SCALE]: '12' };
		const tree = await profiled('scale-annotation', { profile: { environment: 'test', size: 'small' }, service: { annotations }});

		expect(annotationsOf(tree)[MAX_SCALE]).toBe('12');
	});

	it.each(SIZE_TABLE)('counts the maxScale annotation of the caller for the $size budget: the largest scale that fits builds, one more is rejected', async function(row) {
		const profile: Profile = { environment: 'test', size: row.size };
		const connections = Number(flagsOf(await profiled(`scale-read-${row.size}`, { profile })).max_connections);
		const largest = Math.floor((connectionBudget(connections).available - row.workerPool) / row.webPool);
		const scaledTo = function(instances: number): Partial<ServiceArgs> {
			return({ profile, service: { annotations: { [MAX_SCALE]: String(instances) }}});
		};

		expect(annotationsOf(await profiled(`scale-in-${row.size}`, scaledTo(largest)))[MAX_SCALE]).toBe(String(largest));
		await expect(profiled(`scale-out-${row.size}`, scaledTo(largest + 1))).rejects.toBeInstanceOf(ConnectionBudgetExceededError);
	});

	it('counts the maxScale annotation of the caller as 100 instances when it is an Output', async function() {
		const built = profiled('scale-output', { profile: { environment: 'test', size: 'small' }, service: { annotations: { [MAX_SCALE]: pulumi.output('12') }}});

		await expect(built).rejects.toBeInstanceOf(ConnectionBudgetExceededError);
	});

	it('writes the backups of a production database and none for a development one', async function() {
		const backups = await profiled('profile-backups-production', { profile: production });
		const none = await profiled('profile-backups-development', { profile: { environment: 'development', size: 'small' }});

		expect(databaseInput(backups, [ 'settings', 'backupConfiguration', 'enabled' ])).toBe(true);
		expect(databaseInput(none, [ 'settings', 'backupConfiguration' ])).toBeUndefined();
	});

	it('builds the same app from the spread values of the profiles export as from the profile', async function() {
		const profile = production;
		/* `kv` is left out: it would add a store that the profiled app does not have */
		const { database, service, vpc, worker } = profiles[profile.environment][profile.size];
		const fromProfile = await profiled('spread-app', { profile });
		const spread = await captureService('spread-app', { database, service, vpc, worker: { kind: 'crwp', ...worker }});

		expect(describeTree(spread)).toEqual(describeTree(fromProfile));
	});

	it('is the same app whether profile is left out or undefined', async function() {
		const left = await profiled('profile-undefined', {});
		const undefinedProfile = await profiled('profile-undefined', { profile: undefined });

		expect(describeTree(undefinedProfile)).toEqual(describeTree(left));
	});

	const snapshots: Profile[] = [
		{ environment: 'test', size: 'small' },
		{ environment: 'production', size: 'large' }
	];

	it.each(snapshots)('keeps its resources, parents and key inputs for $environment $size', async function(profile) {
		const tree = await profiled(`profile-${profile.environment}-${profile.size}`, { profile, migration: { enabled: true }});

		expect(describeTree(tree)).toMatchSnapshot();
	});

	/*
	 * The profile bounds the connections: its tier and max_connections give
	 * the budget, its instances and pool sizes the demand. An explicit pool
	 * size takes the rest of the budget (the worker keeps 1 connection per
	 * instance), so one more must fail, and the check runs by itself.
	 */
	it.each(SIZE_TABLE)('fits the explicit pool size of the largest service the $size budget holds, and rejects one more', async function(row) {
		const profile: Profile = { environment: 'production', size: row.size };
		const connections = Number(flagsOf(await profiled(`limit-read-${row.size}`, { profile })).max_connections);
		const largest = Math.floor((connectionBudget(connections).available - 1) / row.maxInstances);
		const withPool = function(poolSize: number): Partial<ServiceArgs> {
			return({ profile, database: { poolSize }, worker: { kind: 'crwp', poolSize: 1 }});
		};

		expect(ofType(await profiled(`limit-in-${row.size}`, withPool(largest)), SERVICE_TYPE)).toHaveLength(1);
		await expect(profiled(`limit-out-${row.size}`, withPool(largest + 1))).rejects.toBeInstanceOf(ConnectionBudgetExceededError);
	});
});

describe('the Redis and the connector of a service with a profile', function() {
	useIsolatedHome();

	const REDIS = 'gcp:redis/instance:Instance';
	const CONNECTOR = 'gcp:vpcaccess/connector:Connector';
	const production = { environment: 'production', size: 'large' } as const;
	const values = resolveProfile(production);

	function inputOf(tree: TreeSnapshot, type: string, field: string) {
		return(optionalRecord(ofType(tree, type)[0]?.inputs)?.[field]);
	}

	it('gives the Redis of the app the memory of the profile when kv names none', async function() {
		const tree = await profiled('kv-profile', { profile: production, kv: { type: 'redis' }});

		expect(inputOf(tree, REDIS, 'memorySizeGb')).toBe(values.kv.memorySizeGb);
	});

	it('keeps the memory of the caller for the Redis, whatever the profile says', async function() {
		const tree = await profiled('kv-explicit', { profile: production, kv: { type: 'redis', memorySizeGb: values.kv.memorySizeGb + 1 }});

		expect(inputOf(tree, REDIS, 'memorySizeGb')).toBe(values.kv.memorySizeGb + 1);
	});

	it('rejects a Redis without memory when no profile gives it', async function() {
		const result = profiled('kv-none', { kv: { type: 'redis' }});

		await expect(result).rejects.toBeInstanceOf(CloudRunServiceArgsError);
		await expect(result).rejects.toThrow(/kv\.memorySizeGb is required unless a profile gives it/);
	});

	it('sizes the connector of the app from the profile', async function() {
		const tree = await profiled('connector-profile', { profile: production });

		expect(inputOf(tree, CONNECTOR, 'minInstances')).toBe(values.vpc.connector.minInstances);
		expect(inputOf(tree, CONNECTOR, 'maxInstances')).toBe(values.vpc.connector.maxInstances);
	});

	it('keeps the connector sizes of the caller, one at a time', async function() {
		const tree = await profiled('connector-explicit', { profile: production, vpc: { connector: { minInstances: 4 }}});

		expect(inputOf(tree, CONNECTOR, 'minInstances')).toBe(4);
		expect(inputOf(tree, CONNECTOR, 'maxInstances')).toBe(values.vpc.connector.maxInstances);
	});
});

describe('a FullStackApp whose backend has a profile', function() {
	useIsolatedHome();

	function tierOf(backend: Partial<ServiceArgs>) {
		return(captureTree(function() {
			return(new FullStackApp('profile-full-stack', {
				loadBalancer: { domain: 'app.example.com', ssl: { domains: [ 'app.example.com' ] }},
				frontend: null,
				backend: { gcp: { project: 'project-id' }, region: 'us-central1', image: { uri: 'us-central1-docker.pkg.dev/project-id/keeta/app:1' }, database: {}, ...backend }
			}));
		}));
	}

	const small = { environment: 'test', size: 'small' } as const;
	const rows: { title: string; backend: Partial<ServiceArgs>; tier: string; scale: string | undefined }[] = [
		{ title: 'sizes the backend from the profile', backend: { profile: small }, tier: 'db-g1-small', scale: '12' },
		{ title: 'lets an argument of the backend beat the profile', backend: { profile: small, database: { tier: 'db-custom-2-7680' }}, tier: 'db-custom-2-7680', scale: '12' },
		{ title: 'leaves the backend as it was with no profile', backend: {}, tier: 'db-f1-micro', scale: undefined }
	];

	it.each(rows)('$title', async function(row) {
		const tree = await tierOf(row.backend);

		expect(databaseInput(tree, [ 'settings', 'tier' ])).toBe(row.tier);
		expect(annotationsOf(tree)[MAX_SCALE]).toBe(row.scale);
	});
});
