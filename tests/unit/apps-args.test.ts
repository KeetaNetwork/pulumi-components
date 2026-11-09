import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pulumi from '@pulumi/pulumi';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as apps from '../../src/packages/gcp/apps';
import type * as appsArgs from '../../src/packages/gcp/apps-args';
import { leavesOf } from '../helpers/leaves';
import { expectAt, optionalRecord, valueAt } from '../helpers/narrow';
import { WORKER_FORMS } from '../helpers/worker-forms';
import { requireSource } from './harness/load-sources';
import { captureTree, useIsolatedHome } from './harness/pulumi-tree';

const { CloudRunService } = requireSource<typeof apps>('src/packages/gcp/apps.ts');
const { parseCloudRunServiceArgs, CloudRunServiceArgsError } = requireSource<typeof appsArgs>('src/packages/gcp/apps-args.ts');

type ServiceArgs = Parameters<typeof parseCloudRunServiceArgs>[0];

const APP_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/app');
const IMAGE = 'us-central1-docker.pkg.dev/project-id/keeta/app:1';
const BUILD = { directory: APP_DIRECTORY, imageName: 'app' };

/*
 * JavaScript callers are not held to the argument types, so the parser has
 * to check what the types promise. The tests hand it combinations the types
 * forbid; this guard checks only what those combinations leave alone.
 */
function isServiceArgs(value: unknown): value is ServiceArgs {
	const record = optionalRecord(value);

	return(record !== undefined && optionalRecord(record.gcp) !== undefined && typeof record.region === 'string' && optionalRecord(record.image) !== undefined);
}

function callerArgs(overrides: unknown) {
	const args: unknown = { gcp: { project: 'project-id' }, region: 'us-central1', image: { uri: IMAGE }, ...optionalRecord(overrides) };
	if (!isServiceArgs(args)) {
		throw(new TypeError('The test arguments are not service arguments'));
	}

	return(args);
}

function parse(overrides: unknown) {
	return(parseCloudRunServiceArgs(callerArgs(overrides)));
}

afterEach(function() {
	vi.restoreAllMocks();
});

interface Rule {
	rule: string;
	/** Arguments the rule rejects */
	outside: unknown;
	/** The nearest arguments the rule accepts */
	inside: unknown;
	message: string | RegExp;
}

const RULES: Rule[] = [
	{
		rule: 'an image needs a uri or a build',
		outside: { image: {}},
		inside: { image: { uri: IMAGE }},
		message: /image\.uri.*image\.build/
	},
	{
		rule: 'an image cannot have both a uri and a build',
		outside: { image: { uri: IMAGE, build: BUILD }},
		inside: { image: { build: BUILD }},
		message: /image\.uri.*image\.build/
	},
	{
		rule: 'a migration needs a database',
		outside: { migration: { enabled: true }},
		inside: { migration: { enabled: false }},
		message: 'migration.enabled requires database'
	},
	{
		rule: 'a legacy mig worker pool cannot enable SSH',
		outside: { mig: { enabled: true, workerKind: 'crwp', enableSSH: true }},
		inside: { mig: { enabled: true, workerKind: 'crwp', enableSSH: false }},
		message: /enableSSH/
	},
	{
		rule: 'a worker pool cannot enable SSH',
		outside: { worker: { kind: 'crwp', enableSSH: true }},
		inside: { worker: { kind: 'mig', enableSSH: true }},
		message: /enableSSH/
	},
	{
		rule: 'a legacy mig worker pool cannot have a cosImage',
		outside: { mig: { enabled: true, workerKind: 'crwp', cosImage: 'cos-stable' }},
		inside: { mig: { enabled: true, workerKind: 'mig', cosImage: 'cos-stable' }},
		message: /cosImage/
	},
	{
		rule: 'a worker pool cannot have a cosImage',
		outside: { worker: { kind: 'crwp', cosImage: 'cos-stable' }},
		inside: { worker: { kind: 'mig', cosImage: 'cos-stable' }},
		message: /cosImage/
	},
	{
		rule: 'mig and worker cannot both be given',
		outside: { mig: { enabled: true }, worker: { kind: 'mig' }},
		inside: { worker: { kind: 'mig' }},
		message: /\bmig\b.*\bworker\b/
	}
];

const RULE_ROWS = RULES.map(function(row): [ string, Rule ] {
	return([ row.rule, row ]);
});

describe('parseCloudRunServiceArgs rules', function() {
	it.each(RULE_ROWS)('rejects it when %s', function(_rule, row) {
		function parseOutside() {
			return(parse(row.outside));
		}

		expect(parseOutside).toThrow(CloudRunServiceArgsError);
		expect(parseOutside).toThrow(row.message);
	});

	it.each(RULE_ROWS)('accepts it at the limit when %s', function(_rule, row) {
		expect(function() {
			return(parse(row.inside));
		}).not.toThrow();
	});

	it('throws an Error', function() {
		expect(function() {
			return(parse(RULES[0]?.outside));
		}).toThrow(Error);
	});

	it('leaves the arguments it reads as they were', function() {
		const args = callerArgs({ database: {}, mig: { enabled: true, machineType: 'e2-small' }});
		const before = JSON.stringify(args);

		parseCloudRunServiceArgs(args);

		expect(JSON.stringify(args)).toBe(before);
	});
});

describe('CloudRunService with arguments the parser rejects', function() {
	useIsolatedHome();

	it.each(RULE_ROWS)('is rejected by the parser when %s', async function(rule, row) {
		const name = `rejected-${rule.replace(/ /g, '-')}`;

		await expect(captureTree(function() {
			return(new CloudRunService(name, callerArgs(row.outside)));
		})).rejects.toThrow(CloudRunServiceArgsError);
	});
});

describe('parseCloudRunServiceArgs image', function() {
	it('parses a uri into a uri image', function() {
		expect(valueAt(parse({}), [ 'image', 'kind' ])).toBe('uri');
		expect(valueAt(parse({}), [ 'image', 'uri' ])).toBe(IMAGE);
	});

	it('parses a build into a build image', function() {
		const parsed = parse({ image: { build: BUILD }});

		expect(valueAt(parsed, [ 'image', 'kind' ])).toBe('build');
		expect(valueAt(parsed, [ 'image', 'build', 'imageName' ])).toBe('app');
	});
});

interface Presence {
	vpc: boolean;
	network: boolean;
	database: boolean;
	migration: boolean;
	kv: boolean;
	worker: boolean;
}

function presenceOf(parsed: unknown): Presence {
	function has(steps: string[]) {
		return(valueAt(parsed, steps) !== undefined);
	}

	return({
		vpc: has([ 'vpc' ]),
		network: has([ 'vpc', 'network' ]),
		database: has([ 'vpc', 'data', 'database' ]),
		migration: has([ 'vpc', 'data', 'migration' ]),
		kv: has([ 'vpc', 'kv' ]),
		worker: has([ 'vpc', 'worker' ])
	});
}

/*
 * Worker, data and kv are nested under the network, so a parsed value cannot
 * have one without a network.
 */
describe('parseCloudRunServiceArgs network', function() {
	const none: Presence = { vpc: false, network: false, database: false, migration: false, kv: false, worker: false };
	const network: Presence = { ...none, vpc: true, network: true };
	const rows: [ string, unknown, Presence ][] = [
		[ 'nothing that needs a network', {}, none ],
		[ 'a vpc section alone', { vpc: {}}, network ],
		[ 'a database', { database: {}}, { ...network, database: true }],
		[ 'a database and a migration', { database: {}, migration: { enabled: true }}, { ...network, database: true, migration: true }],
		[ 'a database and a disabled migration', { database: {}, migration: { enabled: false }}, { ...network, database: true }],
		[ 'a kv', { kv: { type: 'redis', memorySizeGb: 1 }}, { ...network, kv: true }],
		[ 'a legacy mig worker', { mig: { enabled: true }}, { ...network, worker: true }],
		[ 'a worker', { worker: { kind: 'mig' }}, { ...network, worker: true }],
		[ 'a disabled legacy mig worker', { mig: { enabled: false }}, none ],
		[ 'a database and a disabled legacy mig worker', { database: {}, mig: { enabled: false }}, { ...network, database: true }]
	];

	it.each(rows)('has the nested sections of %s', function(_description, overrides, expected) {
		expect(presenceOf(parse(overrides))).toEqual(expected);
	});
});

describe('parseCloudRunServiceArgs identity', function() {
	const rows: [ string, unknown, boolean, boolean ][] = [
		[ 'by default', {}, true, false ],
		[ 'when roles are not granted', { service: { grantIAMRoles: false }}, false, false ],
		[ 'when the caller gives the account', { service: { serviceAccount: 'worker@project-id.iam.gserviceaccount.com' }}, false, true ],
		[ 'when the caller gives the account and asks for the roles', { service: { grantIAMRoles: true, serviceAccount: 'worker@project-id.iam.gserviceaccount.com' }}, false, true ]
	];

	it.each(rows)('has the roles and account %s', function(_description, overrides, grantRoles, hasAccount) {
		const parsed = parse(overrides);

		expect(valueAt(parsed, [ 'identity', 'grantRoles' ])).toBe(grantRoles);
		expect(valueAt(parsed, [ 'identity', 'account' ]) !== undefined).toBe(hasAccount);
	});
});

const WORKER_ROWS = WORKER_FORMS.map(function(form): [ string, typeof form ] {
	return([ form.description, form ]);
});

describe('parseCloudRunServiceArgs legacy mig', function() {
	it.each(WORKER_ROWS)('parses %s the same as the worker', function(_description, form) {
		const legacy = parse({ mig: form.legacy });
		const typed = parse({ worker: form.worker });

		expect(valueAt(typed, [ 'vpc', 'worker', 'kind' ])).toBe(form.kind);
		expect(legacy).toEqual(typed);
	});

	it.each(WORKER_ROWS)('warns once about %s', function(_description, form) {
		const warn = vi.spyOn(pulumi.log, 'warn');

		parse({ mig: form.legacy });

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\bmig\b.*\bworker\b/));
	});

	it.each(WORKER_ROWS)('does not warn about %s given as a worker', function(_description, form) {
		const warn = vi.spyOn(pulumi.log, 'warn');

		parse({ worker: form.worker });

		expect(warn).not.toHaveBeenCalled();
	});

	it('parses a disabled mig as no worker at all', function() {
		expect(parse({ database: {}, mig: { enabled: false }})).toEqual(parse({ database: {}}));
	});
});

describe('parseCloudRunServiceArgs defaults', function() {
	const remoteBuild = { image: { build: { ...BUILD, remote: {}}}};

	/* [ description, arguments, section of the parsed value, values it holds, values it must not hold ] */
	const rows: [ string, unknown, string[], unknown[], unknown[] ][] = [
		[ 'the database', { database: {}}, [ 'vpc', 'data', 'database' ], [ 'db-f1-micro', 4500, 25000 ], [ 'POSTGRES_14', 'POSTGRES_18' ] ],
		[ 'the network', { database: {}}, [ 'vpc', 'network' ], [ '10.97.35.0/24', '10.97.36.0/28', 2, 3, 16 ], [] ],
		[ 'the service', {}, [ 'service' ], [ 1, 512 ], [] ],
		[ 'the migration', { database: {}, migration: { enabled: true }}, [ 'vpc', 'data', 'migration' ], [ 1, 512, 600 ], [] ],
		[ 'a container VM worker', { mig: { enabled: true }}, [ 'vpc', 'worker' ], [ 'e2-micro', 'vpc' ], [] ],
		[ 'a Cloud Run worker pool', { mig: { enabled: true, workerKind: 'crwp' }}, [ 'vpc', 'worker' ], [ 'e2-micro', 'vpc' ], [] ],
		[ 'the remote build', remoteBuild, [ 'image', 'build' ], [ 'linux/amd64', 28800 ], [] ],
		[
			'a database the caller sets',
			{ database: { tier: 'db-custom-2-7680', version: 'POSTGRES_15', queryStringLength: 2048, flags: { max_connections: 100 }}},
			[ 'vpc', 'data', 'database' ],
			[ 'db-custom-2-7680', 'POSTGRES_15', 2048, 100 ],
			[ 'db-f1-micro', 'POSTGRES_14', 'POSTGRES_18', 4500, 25000 ]
		],
		[
			'a network the caller sets',
			{ database: {}, vpc: { subnetCIDR: '10.1.0.0/24', connectorCIDR: '10.1.1.0/28', connector: { minInstances: 4, maxInstances: 8 }, psaPrefixLength: 20 }},
			[ 'vpc', 'network' ],
			[ '10.1.0.0/24', '10.1.1.0/28', 4, 8, 20 ],
			[ '10.97.35.0/24', '10.97.36.0/28', 2, 3, 16 ]
		],
		[
			'a service the caller sets',
			{ service: { cpuLimit: 2, memoryLimit: 1024 }},
			[ 'service' ],
			[ 2, 1024 ],
			[ 512 ]
		],
		[
			'a build the caller sets',
			{ image: { build: { ...BUILD, platform: 'linux/arm64', remote: { timeoutSeconds: 3600 }}}},
			[ 'image', 'build' ],
			[ 'linux/arm64', 3600 ],
			[ 'linux/amd64', 28800 ]
		]
	];

	it.each(rows)('fills %s', function(description, overrides, section, held, absent) {
		const leaves = leavesOf(expectAt(parse(overrides), section, `the parsed arguments of ${description}`));

		for (const value of held) {
			expect(leaves).toContain(value);
		}

		for (const value of absent) {
			expect(leaves).not.toContain(value);
		}
	});
});

describe('CloudRunService with the legacy mig worker or the worker', function() {
	useIsolatedHome();

	it.each(WORKER_ROWS)('gives %s the same tree', async function(description, form) {
		const name = `worker-forms-${form.kind}`;
		const legacy = await captureTree(function() {
			return(new CloudRunService(name, callerArgs({ mig: form.legacy })));
		});
		const typed = await captureTree(function() {
			return(new CloudRunService(name, callerArgs({ worker: form.worker })));
		});

		expect(typed.resources.map(function(resource) {
			return(resource.type);
		}), description).toContain(form.componentType);
		expect(typed).toEqual(legacy);
	});
});
