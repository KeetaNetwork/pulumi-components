import { describe, expect, it } from 'vitest';

import type * as defaults from '../../src/packages/gcp/defaults';
import { isDeeplyFrozen, leavesOf } from '../helpers/leaves';
import { requireSource } from './harness/load-sources';

const moduleDefaults = requireSource<typeof defaults>('src/packages/gcp/defaults.ts');
const { CLOUD_RUN_SERVICE_DEFAULTS, POSTGRES_DEFAULTS, BUILD_DEFAULTS, CONTAINER_DEFAULTS, MIGRATION_DEFAULTS, ROUTING_DEFAULTS, FRONT_END_DEFAULTS, PROFILE_PRESETS } = moduleDefaults;

const exported = {
	CLOUD_RUN_SERVICE_DEFAULTS,
	POSTGRES_DEFAULTS,
	BUILD_DEFAULTS,
	CONTAINER_DEFAULTS,
	MIGRATION_DEFAULTS,
	ROUTING_DEFAULTS,
	FRONT_END_DEFAULTS,
	PROFILE_PRESETS
};

type ExportName = keyof typeof exported;

const MACHINE_SCOPES = [
	'https://www.googleapis.com/auth/cloud-platform',
	'https://www.googleapis.com/auth/compute',
	'https://www.googleapis.com/auth/devstorage.read_only',
	'https://www.googleapis.com/auth/logging.write',
	'https://www.googleapis.com/auth/monitoring.write',
	'https://www.googleapis.com/auth/servicecontrol',
	'https://www.googleapis.com/auth/service.management.readonly'
];

/*
 * The values are those of 1.0.95. The P2 snapshot proves that the components
 * still use them; these tests prove that the module holds them, in the
 * object the Design gives each one, and that nobody can change them.
 */
describe('defaults module', function() {
	const names = Object.keys(exported);

	it.each(names)('exports %s as a frozen object', function(name) {
		const value: unknown = Reflect.get(exported, name);

		expect(value).toBeTypeOf('object');
		expect(isDeeplyFrozen(value)).toBe(true);
	});

	it('keeps the worker defaults of each entry point apart', function() {
		expect(CLOUD_RUN_SERVICE_DEFAULTS.worker.machineType).toBe('e2-micro');
		expect(CONTAINER_DEFAULTS.mig.machineType).toBe('e2-medium');
		expect(CONTAINER_DEFAULTS.crwp.size).toEqual({ cpu: '2', ram: '4096' });
	});

	/* The two front ends differ on purpose (Design DE7): unifying the lists would update the URL map of every StaticWebApp */
	it('keeps the routing defaults of each front end apart', function() {
		const paths = [ '/assets/', '/icons/', '/fonts/', '/images/' ];

		expect(ROUTING_DEFAULTS.staticWebApp).toEqual({ staticPaths: paths, staticFiles: [] });
		expect(ROUTING_DEFAULTS.fullStack).toEqual({ staticPaths: paths, staticFiles: [ '/favicon.svg' ] });
	});

	it('holds the TLS policy of the front ends', function() {
		expect(FRONT_END_DEFAULTS.sslPolicy).toEqual({ profile: 'MODERN', minTlsVersion: 'TLS_1_2' });
	});

	/* [ object, value it holds, how many times it holds it ] */
	const held: [ ExportName, unknown, number ][] = [
		[ 'POSTGRES_DEFAULTS', 'db-f1-micro', 1 ],
		[ 'POSTGRES_DEFAULTS', 'POSTGRES_18', 1 ],
		[ 'POSTGRES_DEFAULTS', 4500, 1 ],
		[ 'POSTGRES_DEFAULTS', 25000, 1 ],
		[ 'BUILD_DEFAULTS', 'linux/amd64', 1 ],
		[ 'BUILD_DEFAULTS', 28800, 1 ],
		[ 'BUILD_DEFAULTS', 'E2_HIGHCPU_8', 1 ],
		[ 'CONTAINER_DEFAULTS', 50, 1 ],
		[ 'MIGRATION_DEFAULTS', 512, 1 ],
		[ 'MIGRATION_DEFAULTS', 600, 1 ],
		/* The CPU limit and the retry count are both 1 */
		[ 'MIGRATION_DEFAULTS', 1, 2 ],
		[ 'CLOUD_RUN_SERVICE_DEFAULTS', 512, 1 ],
		...MACHINE_SCOPES.map(function(scope): [ ExportName, unknown, number ] {
			return([ 'CONTAINER_DEFAULTS', scope, 1 ]);
		})
	];

	it.each(held)('%s holds %j at least %i time', function(name, value, count) {
		const matches = leavesOf(Reflect.get(exported, name)).filter(function(leaf) {
			return(leaf === value);
		});

		expect(matches.length).toBeGreaterThanOrEqual(count);
	});

	/* Where the Design does not say which object holds the value, any of them may */
	const heldAnywhere: [ string, unknown ][] = [
		[ 'the subnet range', '10.97.35.0/24' ],
		[ 'the connector range', '10.97.36.0/28' ],
		[ 'the connector minimum', 2 ],
		[ 'the connector maximum', 3 ],
		[ 'the private service access prefix', 16 ],
		[ 'the Cloud Run CPU', 1 ],
		[ 'the IAP range', '35.235.240.0/20' ],
		[ 'the IAP priority', 900 ],
		[ 'the Redis firewall priority', 850 ]
	];

	it.each(heldAnywhere)('holds %s (%j) in one of its objects', function(_description, value) {
		const all = leavesOf(Object.values(exported));

		expect(all).toContain(value);
	});
});
