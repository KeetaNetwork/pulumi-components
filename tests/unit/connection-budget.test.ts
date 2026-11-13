import * as gcp from '@pulumi/gcp';
import { describe, expect, it } from 'vitest';

import type * as budget from '../../src/packages/gcp/connection-budget';
import type * as sql from '../../src/packages/gcp/sql';
import { expectArray, expectDefined, expectRecord, valueAt } from '../helpers/narrow';
import { requireSource } from './harness/load-sources';
import { captureTree, ofType, useIsolatedHome } from './harness/pulumi-tree';
import type { TreeSnapshot } from './harness/pulumi-tree';

const { parseCloudSQLTier, tierDefaultMaxConnections, resolveMaxConnections, connectionBudget, assertWithinBudget, ConnectionBudgetExceededError, MaxConnectionsConflictError } = requireSource<typeof budget>('src/packages/gcp/connection-budget.ts');
const { PostgresCloudSQL } = requireSource<typeof sql>('src/packages/gcp/sql.ts');

const DATABASE_INSTANCE = 'gcp:sql/databaseInstance:DatabaseInstance';
const MEGABYTES_PER_GIGABYTE = 1024;

describe('parseCloudSQLTier', function() {
	const tiers = [
		{ tier: 'db-custom-2-7680', shape: { kind: 'custom', memoryMB: 7680 }},
		{ tier: 'db-custom-16-61440', shape: { kind: 'custom', memoryMB: 61440 }},
		{ tier: 'db-f1-micro', shape: { kind: 'shared', name: 'db-f1-micro', maxConnections: 25 }},
		{ tier: 'db-g1-small', shape: { kind: 'shared', name: 'db-g1-small', maxConnections: 50 }},
		{ tier: 'db-perf-optimized-N-8', shape: { kind: 'unknown', tier: 'db-perf-optimized-N-8' }},
		{ tier: 'db-custom-2', shape: { kind: 'unknown', tier: 'db-custom-2' }},
		{ tier: 'db-custom-two-7680', shape: { kind: 'unknown', tier: 'db-custom-two-7680' }},
		{ tier: 'db-custom-2-7680-extra', shape: { kind: 'unknown', tier: 'db-custom-2-7680-extra' }},
		{ tier: 'DB-F1-MICRO', shape: { kind: 'unknown', tier: 'DB-F1-MICRO' }},
		{ tier: '', shape: { kind: 'unknown', tier: '' }}
	];

	it.each(tiers)('reads "$tier" as $shape.kind', function(testCase) {
		expect(parseCloudSQLTier(testCase.tier)).toEqual(testCase.shape);
	});
});

/* The defaults of Cloud SQL: the memory of a custom tier decides, 1 GB being 1024 MB */
describe('tierDefaultMaxConnections', function() {
	function custom(memoryMB: number) {
		return(tierDefaultMaxConnections(parseCloudSQLTier(`db-custom-2-${memoryMB}`)));
	}

	const shared = [
		{ tier: 'db-f1-micro', connections: 25 },
		{ tier: 'db-g1-small', connections: 50 }
	];

	it.each(shared)('gives $tier $connections', function(testCase) {
		expect(tierDefaultMaxConnections(parseCloudSQLTier(testCase.tier))).toBe(testCase.connections);
	});

	/* Each band starts at its lower edge (inside) and ends one MB before the next band (outside the next) */
	const bands = [
		{ from: 3.75, before: 6, connections: 100 },
		{ from: 6, before: 7.5, connections: 200 },
		{ from: 7.5, before: 15, connections: 400 },
		{ from: 15, before: 30, connections: 500 },
		{ from: 30, before: 60, connections: 600 },
		{ from: 60, before: 120, connections: 800 }
	];

	it.each(bands)('gives $connections from $from GB up to, and not including, $before GB', function(band) {
		expect(custom(band.from * MEGABYTES_PER_GIGABYTE)).toBe(band.connections);
		expect(custom(band.before * MEGABYTES_PER_GIGABYTE - 1)).toBe(band.connections);
	});

	it.each([ 120, 128, 624 ])('gives 1000 from 120 GB up (%s GB)', function(gigabytes) {
		expect(custom(gigabytes * MEGABYTES_PER_GIGABYTE)).toBe(1000);
	});

	it('does not throw for a tier it does not know until a default is asked for', function() {
		const shape = parseCloudSQLTier('db-perf-optimized-N-8');

		expect(shape).toEqual({ kind: 'unknown', tier: 'db-perf-optimized-N-8' });
		expect(function() {
			return(tierDefaultMaxConnections(shape));
		}).toThrow('db-perf-optimized-N-8');
	});
});

describe('resolveMaxConnections', function() {
	const resolved = [
		{ title: 'the flag', source: { tier: 'db-g1-small', flags: { max_connections: 75 }}, connections: 75 },
		{ title: 'the number of maxConnections', source: { tier: 'db-g1-small', maxConnections: 120 }, connections: 120 },
		{ title: 'the default of the tier for "tier-default"', source: { tier: 'db-g1-small', maxConnections: 'tier-default' as const }, connections: 50 },
		{ title: 'the default of the tier when neither is given', source: { tier: 'db-custom-2-7680' }, connections: 400 },
		{ title: 'the default of the tier when flags has no max_connections', source: { tier: 'db-f1-micro', flags: {}}, connections: 25 },
		{ title: 'the number when the flag is undefined, since an undefined flag is not given', source: { tier: 'db-g1-small', flags: { max_connections: undefined }, maxConnections: 120 }, connections: 120 },
		{ title: 'the flag of a tier it does not know', source: { tier: 'db-perf-optimized-N-8', flags: { max_connections: 300 }}, connections: 300 },
		{ title: 'the number of a tier it does not know', source: { tier: 'db-perf-optimized-N-8', maxConnections: 300 }, connections: 300 }
	];

	it.each(resolved)('gives $title', function(testCase) {
		expect(resolveMaxConnections(testCase.source)).toBe(testCase.connections);
	});

	const conflicting = [
		{ title: 'a number', maxConnections: 120 as const },
		{ title: '"tier-default"', maxConnections: 'tier-default' as const }
	];

	it.each(conflicting)('throws a MaxConnectionsConflictError when the flag and $title are both given', function(testCase) {
		expect(function() {
			return(resolveMaxConnections({ tier: 'db-g1-small', flags: { max_connections: 75 }, maxConnections: testCase.maxConnections }));
		}).toThrow(MaxConnectionsConflictError);
	});

	it('names the tier when neither is given and the tier is not known', function() {
		expect(function() {
			return(resolveMaxConnections({ tier: 'db-perf-optimized-N-8' }));
		}).toThrow('db-perf-optimized-N-8');
	});
});

describe('connectionBudget', function() {
	const budgets = [
		{ title: 'a reserve of 10%', maxConnections: 100, expected: { maxConnections: 100, reserve: 10, available: 90 }},
		{ title: 'a reserve of 10% of 25000', maxConnections: 25000, expected: { maxConnections: 25000, reserve: 2500, available: 22500 }},
		{ title: 'no connections', maxConnections: 0, expected: { maxConnections: 0, reserve: 0, available: 0 }}
	];

	it.each(budgets)('works out $title', function(testCase) {
		expect(connectionBudget(testCase.maxConnections)).toEqual(testCase.expected);
	});

	/* Whole connections: the reserve is never rounded below its share, and the two parts add up to the maximum */
	it.each([ 25, 50, 75 ])('splits %s connections into whole numbers that add up, reserving at least 10%%', function(maxConnections) {
		const result = connectionBudget(maxConnections);

		expect(Number.isInteger(result.reserve)).toBe(true);
		expect(result.reserve).toBeGreaterThanOrEqual(maxConnections / 10);
		expect(result.reserve + result.available).toBe(maxConnections);
	});
});

describe('assertWithinBudget', function() {
	/* 100 connections, 10 of them reserved: 90 to share */
	const available90 = connectionBudget(100);

	it('passes when the shares add up to exactly what is available', function() {
		expect(function() {
			assertWithinBudget(available90, [
				{ name: 'api', maxInstances: 6, poolSize: 5 },
				{ name: 'worker', maxInstances: 3, poolSize: 20 }
			]);
		}).not.toThrow();
	});

	it('passes with no consumer at all', function() {
		expect(function() {
			assertWithinBudget(available90, []);
		}).not.toThrow();
	});

	it('throws a ConnectionBudgetExceededError one connection over, listing the share of each consumer', function() {
		const consumers = [
			{ name: 'api', maxInstances: 6, poolSize: 5 },
			{ name: 'worker', maxInstances: 3, poolSize: 20 },
			{ name: 'reports', maxInstances: 1, poolSize: 1 }
		];
		const errors: unknown[] = [];
		try {
			assertWithinBudget(available90, consumers);
		} catch (error) {
			errors.push(error);
		}

		const [ error ] = errors;
		expect(error).toBeInstanceOf(ConnectionBudgetExceededError);
		expect(error).toBeInstanceOf(Error);
		const message = expectRecord(error, 'the error').message;
		expect(message).toEqual(expect.stringContaining('api'));
		expect(message).toEqual(expect.stringContaining('30'));
		expect(message).toEqual(expect.stringContaining('worker'));
		expect(message).toEqual(expect.stringContaining('60'));
		expect(message).toEqual(expect.stringContaining('reports'));
		expect(message).toEqual(expect.stringContaining('91'));
		expect(message).toEqual(expect.stringContaining('90'));
	});
});

/** Builds a component in a program and returns it with the tree it made */
async function captureComponent<Value>(build: () => Value) {
	const built: Value[] = [];
	const tree = await captureTree(function() {
		built.push(build());
	});

	return({ tree, value: expectDefined(built[0], 'the component') });
}

function flagsOf(tree: TreeSnapshot) {
	const [ instance ] = ofType(tree, DATABASE_INSTANCE);
	const flags = expectArray(valueAt(instance?.inputs, [ 'settings', 'databaseFlags' ]) ?? [], 'the database flags');

	return(Object.fromEntries(flags.map(function(flag) {
		const record = expectRecord(flag, 'a database flag');

		return([ String(record.name), String(record.value) ]);
	})));
}

type DatabaseArgs = Partial<ConstructorParameters<typeof PostgresCloudSQL>[1]>;

function buildDatabase(name: string, args: DatabaseArgs) {
	return(captureComponent(function() {
		const network = new gcp.compute.Network(`${name}-network`, { autoCreateSubnetworks: false });

		return(new PostgresCloudSQL(name, { region: 'us-central1', tier: 'db-f1-micro', vpcNetwork: network, createPeering: true, ...args }));
	}));
}

/*
 * The budget a PostgresCloudSQL reports is the one Cloud SQL applies:
 * reading it writes nothing. Only an explicit `maxConnections` writes the flag.
 */
describe('PostgresCloudSQL.connectionBudget', function() {
	useIsolatedHome();

	const tiers = [
		{ tier: 'db-f1-micro', connections: 25 },
		{ tier: 'db-g1-small', connections: 50 },
		{ tier: 'db-custom-2-7680', connections: 400 },
		{ tier: 'db-custom-4-16384', connections: 500 }
	];

	it.each(tiers)('is the default of $tier ($connections) and writes no max_connections flag', async function(testCase) {
		const { tree, value } = await buildDatabase(`budget-${testCase.tier}`, { tier: testCase.tier });

		expect(value.connectionBudget).toEqual(connectionBudget(testCase.connections));
		expect(flagsOf(tree)).not.toHaveProperty('max_connections');
	});

	it('is the explicit flags.max_connections when it is set, and the flag is written as it was', async function() {
		const { tree, value } = await buildDatabase('budget-flag', { tier: 'db-g1-small', flags: { max_connections: 75 }});

		expect(value.connectionBudget).toEqual(connectionBudget(75));
		expect(flagsOf(tree).max_connections).toBe('75');
	});

	it('writes the flag, and reports it, when maxConnections is a number', async function() {
		const { tree, value } = await buildDatabase('budget-number', { tier: 'db-g1-small', maxConnections: 120 });

		expect(value.connectionBudget).toEqual(connectionBudget(120));
		expect(flagsOf(tree).max_connections).toBe('120');
	});

	it('writes the default of the tier as the flag when maxConnections is "tier-default"', async function() {
		const { tree, value } = await buildDatabase('budget-tier-default', { tier: 'db-g1-small', maxConnections: 'tier-default' });

		expect(value.connectionBudget).toEqual(connectionBudget(50));
		expect(flagsOf(tree).max_connections).toBe('50');
	});

	it('builds with a tier it does not know, and fails only when the budget is read', async function() {
		const { value } = await buildDatabase('budget-unknown', { tier: 'db-perf-optimized-N-8' });

		expect(function() {
			return(value.connectionBudget);
		}).toThrow('db-perf-optimized-N-8');
	});

	it('reports the explicit flag of a tier it does not know', async function() {
		const { value } = await buildDatabase('budget-unknown-flag', { tier: 'db-perf-optimized-N-8', flags: { max_connections: 300 }});

		expect(value.connectionBudget).toEqual(connectionBudget(300));
	});

	it('rejects maxConnections together with flags.max_connections', async function() {
		const result = buildDatabase('budget-conflict', { tier: 'db-g1-small', flags: { max_connections: 75 }, maxConnections: 75 });

		await expect(result).rejects.toBeInstanceOf(MaxConnectionsConflictError);
	});

	it('counts a flag that is undefined as not given, so maxConnections is written', async function() {
		const { tree, value } = await buildDatabase('budget-undefined-flag', { tier: 'db-g1-small', flags: { max_connections: undefined }, maxConnections: 120 });

		expect(value.connectionBudget).toEqual(connectionBudget(120));
		expect(flagsOf(tree).max_connections).toBe('120');
	});
});
