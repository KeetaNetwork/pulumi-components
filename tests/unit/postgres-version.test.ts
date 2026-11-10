import { describe, expect, it } from 'vitest';

import { expectDefined, valueAt } from '../helpers/narrow';
import { ofType, useIsolatedHome } from './harness/pulumi-tree';
import type { TreeResource, TreeSnapshot } from './harness/pulumi-tree';
import { buildDatabase, captureService } from './harness/service-builder';
import type { DatabaseArgs } from './harness/service-builder';

const DATABASE_INSTANCE = 'gcp:sql/databaseInstance:DatabaseInstance';
const NEW_DEFAULT = 'POSTGRES_18';
const KEEP_VERSION = [ 'databaseVersion' ];
const WITH_REPLICA: DatabaseArgs = { replication: { multiZone: true, replicaRegions: [ 'us-east1' ] }, backups: { pointInTimeRecovery: true }};

function instanceEnding(tree: TreeSnapshot, ending: string) {
	return(expectDefined(ofType(tree, DATABASE_INSTANCE).find(function(instance) {
		return(instance.name.endsWith(ending));
	}), `the database instance ending in ${ending}`));
}

function versionOf(instance: TreeResource) {
	return(valueAt(instance.inputs, [ 'databaseVersion' ]));
}

function editionOf(instance: TreeResource) {
	return(valueAt(instance.inputs, [ 'settings', 'edition' ]));
}

/*
 * A database that is created without a version is created on the current
 * engine, and one that exists keeps the version it has: the instance
 * ignores `databaseVersion` when the caller gave none, so a plain `up`
 * never upgrades, downgrades or replaces it. The mock harness has no
 * earlier state, so these tests pin the option; the outcome is the
 * `pulumi preview` of a real stack with a 14 database.
 */
describe('the engine version of a PostgresCloudSQL', function() {
	useIsolatedHome();

	it('is created on PostgreSQL 18 and ignores later changes of the version, when none is given', async function() {
		const { tree } = await buildDatabase('version-none', {});
		const master = instanceEnding(tree, '-master');

		expect(versionOf(master)).toBe(NEW_DEFAULT);
		expect(master.ignoreChanges).toEqual(KEEP_VERSION);
	});

	const explicit = [ 'POSTGRES_14', 'POSTGRES_15', 'POSTGRES_17', NEW_DEFAULT ];

	it.each(explicit)('is %s and ignores nothing, when the caller gives it', async function(version) {
		const { tree } = await buildDatabase(`version-${version}`, { databaseVersion: version });
		const master = instanceEnding(tree, '-master');

		expect(versionOf(master)).toBe(version);
		expect(master.ignoreChanges).toBeUndefined();
	});

	it('gives a replica the version of its master, and the same ignore, when none is given', async function() {
		const { tree } = await buildDatabase('version-replica', WITH_REPLICA);
		const master = instanceEnding(tree, '-master');
		const replica = instanceEnding(tree, '-replica');

		expect(versionOf(replica)).toBe(versionOf(master));
		expect(versionOf(replica)).toBe(NEW_DEFAULT);
		expect(replica.ignoreChanges).toEqual(KEEP_VERSION);
		expect(replica.dependsOn).toContain(master.urn);
	});

	it('gives a replica the explicit version of its master, with no ignore on either', async function() {
		const { tree } = await buildDatabase('version-replica-explicit', { ...WITH_REPLICA, databaseVersion: 'POSTGRES_15' });
		const master = instanceEnding(tree, '-master');
		const replica = instanceEnding(tree, '-replica');

		expect([ versionOf(master), versionOf(replica) ]).toEqual([ 'POSTGRES_15', 'POSTGRES_15' ]);
		expect([ master.ignoreChanges, replica.ignoreChanges ]).toEqual([ undefined, undefined ]);
	});
});

/*
 * On PostgreSQL 16 and later the API makes a new instance Enterprise Plus,
 * which only the db-perf-optimized tiers accept. The edition therefore
 * follows from the tier, and it is not ignored: a later change of tier
 * changes it.
 */
describe('the edition of a PostgresCloudSQL', function() {
	useIsolatedHome();

	/* [ the kind of tier, the tier, the edition that is written (nothing for a tier that is not recognised) ] */
	const editions = [
		{ kind: 'shared', tier: 'db-f1-micro', edition: 'ENTERPRISE' },
		{ kind: 'shared', tier: 'db-g1-small', edition: 'ENTERPRISE' },
		{ kind: 'custom', tier: 'db-custom-1-3840', edition: 'ENTERPRISE' },
		{ kind: 'custom', tier: 'db-custom-96-638976', edition: 'ENTERPRISE' },
		{ kind: 'perf-optimized', tier: 'db-perf-optimized-N-2', edition: 'ENTERPRISE_PLUS' },
		{ kind: 'perf-optimized', tier: 'db-perf-optimized-N-128', edition: 'ENTERPRISE_PLUS' },
		{ kind: 'unknown', tier: 'db-mystery-8', edition: undefined },
		{ kind: 'unknown (a near miss of perf-optimized)', tier: 'db-perf-optimized-N-', edition: undefined },
		{ kind: 'unknown (a near miss of perf-optimized)', tier: 'db-perf-optimized-2', edition: undefined },
		{ kind: 'unknown (a near miss of shared)', tier: 'DB-F1-MICRO', edition: undefined }
	];

	it.each(editions)('writes $edition for the $kind tier $tier, and ignores only the version', async function(row) {
		const { tree } = await buildDatabase(`edition-${row.tier}`, { tier: row.tier, flags: { max_connections: 100 }});
		const master = instanceEnding(tree, '-master');

		expect(editionOf(master)).toBe(row.edition);
		expect(master.ignoreChanges).toEqual(KEEP_VERSION);
	});

	it('writes the edition of the tier when the version is explicit too, and when the instance has a replica', async function() {
		const { tree } = await buildDatabase('edition-explicit', { ...WITH_REPLICA, tier: 'db-custom-1-3840', databaseVersion: 'POSTGRES_15' });

		expect([ editionOf(instanceEnding(tree, '-master')), editionOf(instanceEnding(tree, '-replica')) ]).toEqual([ 'ENTERPRISE', 'ENTERPRISE' ]);
	});
});

/* CloudRunService passes the version only when the caller gives it: PostgresCloudSQL owns the default, so it can tell "none" from "18" */
describe('the database of a CloudRunService', function() {
	useIsolatedHome();

	it('is created on PostgreSQL 18, with the default tier on the Enterprise edition and the version ignored, when the caller gives no version', async function() {
		const master = instanceEnding(await captureService('service-version-none', { database: {}}), '-master');

		expect(versionOf(master)).toBe(NEW_DEFAULT);
		expect(editionOf(master)).toBe('ENTERPRISE');
		expect(master.ignoreChanges).toEqual(KEEP_VERSION);
	});

	it('is created on the version of the caller, which nothing ignores', async function() {
		const master = instanceEnding(await captureService('service-version-explicit', { database: { version: 'POSTGRES_15' }}), '-master');

		expect(versionOf(master)).toBe('POSTGRES_15');
		expect(master.ignoreChanges).toBeUndefined();
	});

	it('gets the Enterprise Plus edition from a db-perf-optimized tier of the caller', async function() {
		const master = instanceEnding(await captureService('service-edition-plus', { database: { tier: 'db-perf-optimized-N-2' }}), '-master');

		expect(editionOf(master)).toBe('ENTERPRISE_PLUS');
	});

	/* A profile carries no version: the sizes name Enterprise tiers only, and the version rule is the one of a caller who gave none */
	it.each([ 'small', 'medium', 'large' ] as const)('passes no version with the %s profile: PostgreSQL 18 on the Enterprise edition, the version ignored', async function(size) {
		const master = instanceEnding(await captureService(`service-profile-${size}`, { database: {}, profile: { environment: 'test', size }}), '-master');

		expect(versionOf(master)).toBe(NEW_DEFAULT);
		expect(editionOf(master)).toBe('ENTERPRISE');
		expect(master.ignoreChanges).toEqual(KEEP_VERSION);
	});

	it('keeps the version of the caller with a profile', async function() {
		const master = instanceEnding(await captureService('service-profile-explicit', { database: { version: 'POSTGRES_15' }, profile: { environment: 'test', size: 'small' }}), '-master');

		expect(versionOf(master)).toBe('POSTGRES_15');
		expect(master.ignoreChanges).toBeUndefined();
	});
});
