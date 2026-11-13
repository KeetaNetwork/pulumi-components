import { describe, expect, it } from 'vitest';

import type * as container from '../../src/packages/gcp/container';
import { expectDefined, expectRecord, optionalRecord } from '../helpers/narrow';
import { requireSource } from './harness/load-sources';
import { captureTree, useIsolatedHome } from './harness/pulumi-tree';
import type { TreeResource, TreeSnapshot } from './harness/pulumi-tree';
import { workerSpec, workerSubnetwork } from './harness/tree-cases';
import { captureService } from './harness/service-builder';

const { ContainerMIG } = requireSource<typeof container>('src/packages/gcp/container.ts');

const ZONAL_MANAGER = 'gcp:compute/instanceGroupManager:InstanceGroupManager';
const REGIONAL_MANAGER = 'gcp:compute/regionInstanceGroupManager:RegionInstanceGroupManager';
const POOL = 'gcp:cloudrunv2/workerPool:WorkerPool';
const JOB = 'gcp:cloudrunv2/job:Job';

function only(tree: TreeSnapshot, type: string): TreeResource {
	const matches = tree.resources.filter(function(resource) {
		return(resource.type === type);
	});
	expect(matches).toHaveLength(1);

	return(expectDefined(matches[0], `the ${type}`));
}

/** The URNs of the resources of the migration job that the resource waits for */
function migrationWaits(tree: TreeSnapshot, resource: TreeResource) {
	const job = tree.resources.find(function(candidate) {
		return(candidate.type === JOB);
	});

	return({
		job: job !== undefined && (resource.dependsOn ?? []).includes(job.urn),
		execution: (resource.dependsOn ?? []).some(function(urn) {
			return(urn.includes('migration-exec'));
		})
	});
}

/*
 * The service waits for the migration job, so it runs the new image only on
 * a database that is migrated for it. The workers run the same image, so
 * they wait for the job too.
 */
describe('a worker and the migration job', function() {
	useIsolatedHome();

	it.each([ 'mig', 'crwp' ] as const)('a %s worker rolls after the migration job', async function(kind) {
		const tree = await captureService(`rollout-${kind}`, {
			database: {},
			migration: { enabled: true },
			worker: { kind, egress: 'vpc' }
		});
		const worker = only(tree, kind === 'mig' ? REGIONAL_MANAGER : POOL);

		expect(migrationWaits(tree, worker)).toEqual({ job: true, execution: true });
	});

	it.each([ 'mig', 'crwp' ] as const)('a %s worker without a migration job waits for no job', async function(kind) {
		const tree = await captureService(`rollout-none-${kind}`, {
			database: {},
			worker: { kind, egress: 'vpc' }
		});
		const worker = only(tree, kind === 'mig' ? REGIONAL_MANAGER : POOL);

		expect(migrationWaits(tree, worker)).toEqual({ job: false, execution: false });
	});
});

type MigOptions = ConstructorParameters<typeof ContainerMIG>[1];

function captureMig(name: string, extra: Partial<Pick<MigOptions, 'networkInterfaces' | 'zone'>>) {
	return(captureTree(function() {
		return(new ContainerMIG(name, {
			serviceAccount: 'worker@project-id.iam.gserviceaccount.com',
			subnetwork: workerSubnetwork(name),
			common: { gcp: { project: 'project-id' }},
			containerSpec: workerSpec,
			...extra
		}));
	}));
}

function rolloutOf(tree: TreeSnapshot, type: string) {
	const updatePolicy = expectRecord(optionalRecord(only(tree, type).inputs)?.updatePolicy, 'the update policy');

	return({
		maxSurgeFixed: updatePolicy.maxSurgeFixed,
		replacementMethod: updatePolicy.replacementMethod
	});
}

/*
 * Only one VM at a time can hold a fixed external address. A group that
 * creates the new VM before it deletes the old one stops there, so a group
 * whose VMs hold one deletes the old VM first.
 */
describe('the rollout of a group whose VMs hold a fixed address', function() {
	useIsolatedHome();

	const fixed = [{ accessConfigs: [{ natIp: '203.0.113.10' }] }];

	it.each([
		[ 'regional', {}, REGIONAL_MANAGER ],
		[ 'zonal', { zone: 'us-central1-a' }, ZONAL_MANAGER ]
	] as const)('a %s group recreates each VM without a surge', async function(description, placement, type) {
		const tree = await captureMig(`fixed-${description}`, { ...placement, networkInterfaces: fixed });

		expect(rolloutOf(tree, type)).toEqual({ maxSurgeFixed: 0, replacementMethod: 'RECREATE' });
	});

	const kept: [ string, MigOptions['networkInterfaces'] ][] = [
		[ 'no interfaces', undefined ],
		[ 'an ephemeral address', [{ accessConfigs: [{}] }] ],
		[ 'no access config', [{}] ]
	];

	it.each(kept)('a group with %s keeps the default rollout', async function(description, networkInterfaces) {
		const tree = await captureMig(`ephemeral-${description.replace(/ /g, '-')}`, { networkInterfaces });

		expect(rolloutOf(tree, REGIONAL_MANAGER)).toEqual({ maxSurgeFixed: undefined, replacementMethod: undefined });
	});
});
