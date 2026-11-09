import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as apps from '../../src/packages/gcp/apps';
import type * as container from '../../src/packages/gcp/container';
import type * as sql from '../../src/packages/gcp/sql';
import { expectAt, expectRecord } from '../helpers/narrow';
import { requireSource } from './harness/load-sources';
import { captureTree, useIsolatedHome } from './harness/pulumi-tree';
import type { TreeSnapshot } from './harness/pulumi-tree';
import { workerSpec, workerSubnetwork } from './harness/tree-cases';
import { buildService } from './harness/service-builder';

const { CloudRunService } = requireSource<typeof apps>('src/packages/gcp/apps.ts');
const { ContainerMIG } = requireSource<typeof container>('src/packages/gcp/container.ts');
const { PostgresCloudSQL } = requireSource<typeof sql>('src/packages/gcp/sql.ts');

type ServiceArgs = ConstructorParameters<typeof CloudRunService>[1];
type MigOptions = ConstructorParameters<typeof ContainerMIG>[1];
type PostgresOptions = ConstructorParameters<typeof PostgresCloudSQL>[1];

const APP_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/app');

/** The inputs of the one resource of the type (and the name ending, when the type has several) */
function inputsOf(tree: TreeSnapshot, type: string, nameEnding: string) {
	const matches = tree.resources.filter(function(resource) {
		return(resource.type === type && resource.name.endsWith(nameEnding));
	});

	if (matches.length !== 1) {
		throw(new Error(`Expected one ${type} named *${nameEnding}, found ${matches.length}`));
	}

	return(expectRecord(matches[0]?.inputs, `the inputs of ${type}`));
}

/** A build of a service with the arguments of the caller, `changed` being what the row's setting turns into */
function service(base: Partial<ServiceArgs>, changed: Partial<ServiceArgs>) {
	return(function(name: string, overridden: boolean) {
		let extra = base;
		if (overridden) {
			extra = changed;
		}

		return(buildService(name, extra));
	});
}

function buildMig(name: string, extra: Partial<MigOptions>) {
	return(new ContainerMIG(name, {
		serviceAccount: 'worker@project-id.iam.gserviceaccount.com',
		subnetwork: workerSubnetwork(name),
		common: { gcp: { project: 'project-id' }},
		containerSpec: workerSpec,
		...extra
	}));
}

interface Setting {
	description: string;
	/** Creates the component, with the setting turned on when `overridden` */
	build: (name: string, overridden: boolean) => unknown;
	type: string;
	/** The end of the name of the resource, for a type that has several */
	nameEnding: string;
	path: (string | number)[];
	/** What the resource gets when the caller says nothing: the value of 1.0.95 */
	fallback: unknown;
	/** What the resource gets when the caller sets it */
	override: unknown;
}

/* The image URI is remembered for the life of the process, so every build names its own image */
function remoteBuild(name: string, remote: NonNullable<NonNullable<ServiceArgs['image']['build']>['remote']>) {
	return(buildService(name, { image: { build: { directory: APP_DIRECTORY, imageName: name, githubSha: 'sha-1', remote }}}));
}

const DATABASE_INSTANCE = 'gcp:sql/databaseInstance:DatabaseInstance';

const SETTINGS: Setting[] = [
	{
		description: 'database.version',
		build: service({ database: {}}, { database: { version: 'POSTGRES_15' }}),
		type: DATABASE_INSTANCE,
		nameEnding: '',
		path: [ 'databaseVersion' ],
		fallback: 'POSTGRES_14',
		override: 'POSTGRES_15'
	},
	{
		description: 'database.queryStringLength',
		build: service({ database: {}}, { database: { queryStringLength: 2048 }}),
		type: DATABASE_INSTANCE,
		nameEnding: '',
		path: [ 'settings', 'insightsConfig', 'queryStringLength' ],
		fallback: 4500,
		override: 2048
	},
	{
		description: 'vpc.connector.maxInstances',
		build: service({ vpc: {}}, { vpc: { connector: { maxInstances: 10 }}}),
		type: 'gcp:vpcaccess/connector:Connector',
		nameEnding: '',
		path: [ 'maxInstances' ],
		fallback: 3,
		override: 10
	},
	{
		description: 'vpc.connector.minInstances',
		build: service({ vpc: {}}, { vpc: { connector: { minInstances: 4, maxInstances: 8 }}}),
		type: 'gcp:vpcaccess/connector:Connector',
		nameEnding: '',
		path: [ 'minInstances' ],
		fallback: 2,
		override: 4
	},
	{
		description: 'vpc.psaPrefixLength',
		build: service({ database: {}}, { database: {}, vpc: { psaPrefixLength: 20 }}),
		type: 'gcp:compute/globalAddress:GlobalAddress',
		nameEnding: '-private-ip-alloc',
		path: [ 'prefixLength' ],
		fallback: 16,
		override: 20
	},
	{
		description: 'image.build.remote.timeoutSeconds',
		build: function(name, overridden) {
			if (overridden) {
				return(remoteBuild(name, { timeoutSeconds: 3600 }));
			}

			return(remoteBuild(name, {}));
		},
		type: 'pulumi-nodejs:dynamic:Resource',
		nameEnding: '-image-build',
		path: [ 'build', 'timeout', 'seconds' ],
		fallback: 28800,
		override: 3600
	},
	{
		description: 'worker.diskSizeGb',
		build: service({ mig: { enabled: true }}, { worker: { kind: 'mig', diskSizeGb: 80 }}),
		type: 'gcp:compute/instanceTemplate:InstanceTemplate',
		nameEnding: '',
		path: [ 'disks', 0, 'diskSizeGb' ],
		fallback: 50,
		override: 80
	},
	{
		description: 'diskSizeGb of a ContainerMIG',
		build: function(name, overridden) {
			if (overridden) {
				return(buildMig(name, { diskSizeGb: 80 }));
			}

			return(buildMig(name, {}));
		},
		type: 'gcp:compute/instanceTemplate:InstanceTemplate',
		nameEnding: '',
		path: [ 'disks', 0, 'diskSizeGb' ],
		fallback: 50,
		override: 80
	},
	{
		description: 'databaseVersion of a PostgresCloudSQL',
		build: function(name, overridden) {
			const network = new gcp.compute.Network(`${name}-network`, { autoCreateSubnetworks: false });
			const options: PostgresOptions = { region: 'us-central1', tier: 'db-f1-micro', vpcNetwork: network, createPeering: true };
			if (overridden) {
				return(new PostgresCloudSQL(name, { ...options, databaseVersion: 'POSTGRES_15' }));
			}

			return(new PostgresCloudSQL(name, options));
		},
		type: DATABASE_INSTANCE,
		nameEnding: '',
		path: [ 'databaseVersion' ],
		fallback: 'POSTGRES_14',
		override: 'POSTGRES_15'
	}
];

/*
 * Each setting P6 adds has a default (the value of 1.0.95, which the P2
 * snapshot pins for the cases it covers) and an override. These captures
 * check the override on the input of the resource it is meant for.
 */
describe('settings that P6 makes configurable', function() {
	useIsolatedHome();

	const rows = SETTINGS.map(function(setting): [ string, Setting ] {
		return([ setting.description, setting ]);
	});

	async function read(setting: Setting, overridden: boolean) {
		const name = `settings-${setting.description.replace(/[^a-z]+/gi, '-').toLowerCase()}-${String(overridden)}`;
		const tree = await captureTree(function() {
			return(setting.build(name, overridden));
		});

		return(expectAt(inputsOf(tree, setting.type, setting.nameEnding), setting.path, `the ${setting.description} input`));
	}

	it.each(rows)('%s keeps its default when the caller says nothing', async function(_description, setting) {
		expect(await read(setting, false)).toEqual(setting.fallback);
	});

	it.each(rows)('%s reaches the resource when the caller sets it', async function(_description, setting) {
		expect(await read(setting, true)).toEqual(setting.override);
	});
});

/*
 * A caller that writes `zone: config.get('zone')` passes the key with no
 * value. 1.0.95 built a zonal group for it, and a different resource type
 * means a replacement, so the group stays zonal until 3.0 and the caller is
 * told.
 */
describe('ContainerMIG zone', function() {
	const ZONAL = 'gcp:compute/instanceGroupManager:InstanceGroupManager';
	const REGIONAL = 'gcp:compute/regionInstanceGroupManager:RegionInstanceGroupManager';

	/* [ description, options, resource type of the group, warnings ] */
	const rows: [ string, Partial<MigOptions>, string, number ][] = [
		[ 'regional when zone is absent', {}, REGIONAL, 0 ],
		[ 'zonal when zone is given', { zone: 'us-central1-a' }, ZONAL, 0 ],
		[ 'zonal, with one warning, when zone is undefined', { zone: undefined }, ZONAL, 1 ]
	];

	afterEach(function() {
		vi.restoreAllMocks();
	});

	it.each(rows)('is %s', async function(description, options, type, warnings) {
		const warn = vi.spyOn(pulumi.log, 'warn');
		const tree = await captureTree(function() {
			return(buildMig(`zone-${description.replace(/[^a-z]+/g, '-')}`, options));
		});

		expect(tree.resources.map(function(resource) {
			return(resource.type);
		})).toContain(type);
		expect(warn).toHaveBeenCalledTimes(warnings);
	});

	it('names the zone in the warning', async function() {
		const warn = vi.spyOn(pulumi.log, 'warn');
		await captureTree(function() {
			return(buildMig('zone-warning', { zone: undefined }));
		});

		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/zone/));
	});
});
