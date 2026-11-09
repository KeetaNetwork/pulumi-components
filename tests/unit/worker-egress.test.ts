import { describe, expect, expectTypeOf, it } from 'vitest';

import type * as apps from '../../src/packages/gcp/apps';
import type * as appsArgs from '../../src/packages/gcp/apps-args';
import type * as network from '../../src/packages/gcp/network';
import { expectArray, expectDefined, expectRecord, optionalRecord } from '../helpers/narrow';
import { requireSource } from './harness/load-sources';
import { captureTree, moveAliases, ofType, useIsolatedHome } from './harness/pulumi-tree';
import type { TreeResource, TreeSnapshot } from './harness/pulumi-tree';
import { appNetworkArgs, buildService } from './harness/service-builder';

const { CloudRunServiceArgsError } = requireSource<typeof apps>('src/packages/gcp/apps.ts');
const { AppNetwork } = requireSource<typeof network>('src/packages/gcp/network.ts');

type Egress = 'vpc' | 'vpc+direct' | 'vpc+nat';

const TEMPLATE = 'gcp:compute/instanceTemplate:InstanceTemplate';
const MANAGER = 'gcp:compute/regionInstanceGroupManager:RegionInstanceGroupManager';
const ADDRESS = 'gcp:compute/address:Address';
const ROUTER = 'gcp:compute/router:Router';
const NAT = 'gcp:compute/routerNat:RouterNat';

function workerTree(app: string, worker: { kind: 'mig' | 'crwp'; egress: Egress; instanceCount?: number }) {
	return(captureTree(function() {
		return(buildService(app, { worker }));
	}));
}

function only(tree: TreeSnapshot, type: string) {
	return(expectDefined(ofType(tree, type)[0], `the ${type}`));
}

/** The first network interface of the instance template of a MIG */
function interfaceOf(tree: TreeSnapshot) {
	const interfaces = expectRecord(only(tree, TEMPLATE).inputs, 'the inputs of the template').networkInterfaces;

	const [ first ]: unknown[] = expectArray(interfaces, 'the network interfaces');

	return(expectRecord(first, 'the first network interface'));
}

/*
 * What a MIG worker shows of its egress: the access configuration of its
 * VMs, the NAT that serves them, the address that the NAT uses, and whether
 * the group waits for its instances.
 */
function egressOf(tree: TreeSnapshot) {
	const manager = only(tree, MANAGER);
	const nats = ofType(tree, NAT);
	const nat = nats[0];
	const natInputs = optionalRecord(nat?.inputs);

	return({
		accessConfigs: interfaceOf(tree).accessConfigs,
		natIpOnTemplate: JSON.stringify(only(tree, TEMPLATE).inputs).includes('"natIp"'),
		targetSize: optionalRecord(manager.inputs)?.targetSize,
		waitForInstances: optionalRecord(manager.inputs)?.waitForInstances,
		waitForInstancesStatus: optionalRecord(manager.inputs)?.waitForInstancesStatus,
		addresses: ofType(tree, ADDRESS).map(function(address) {
			return(address.name);
		}),
		routers: ofType(tree, ROUTER).length,
		nats: nats.length,
		allocation: natInputs?.natIpAllocateOption,
		natIps: natInputs?.natIps,
		natWaitsForGroup: nat?.dependsOn?.includes(manager.urn)
	});
}

/*
 * A MIG worker reaches the internet in one of three ways (B4). `vpc+direct`
 * gives each VM an ephemeral external address. `vpc+nat` keeps the reserved
 * address of the worker (`${name}-mig-ext-ip`, so the IP that peers allow
 * does not change) and puts it on a Cloud NAT, so every VM, however many,
 * leaves through that one address and none has an access config of its own.
 */
describe('egress of a container VM worker', function() {
	useIsolatedHome();

	/* [ egress, instances, access configs of a VM, whether the worker has a NAT and the address that it uses ] */
	const rows: [ Egress, number, unknown[], boolean ][] = [
		[ 'vpc', 1, [], false ],
		[ 'vpc', 3, [], false ],
		[ 'vpc+direct', 1, [ {} ], false ],
		[ 'vpc+direct', 3, [ {} ], false ],
		[ 'vpc+nat', 1, [], true ],
		[ 'vpc+nat', 3, [], true ]
	];

	it.each(rows)('with egress %s and %s instance(s): the access config of a VM, the NAT and the wait', async function(egress, instanceCount, accessConfigs, hasNat) {
		const app = `egress-${egress.replace('+', '-')}-${instanceCount}`;
		const facts = egressOf(await workerTree(app, { kind: 'mig', egress, instanceCount }));
		let expected: { [key: string]: unknown } = {
			accessConfigs,
			natIpOnTemplate: false,
			targetSize: instanceCount,
			addresses: [],
			routers: 0,
			nats: 0
		};
		if (hasNat) {
			expected = {
				...expected,
				waitForInstances: true,
				waitForInstancesStatus: 'UPDATED',
				addresses: [ `${app}-mig-ext-ip` ],
				routers: 1,
				nats: 1,
				allocation: 'MANUAL_ONLY',
				natIps: [ `self-link.${app}-mig-ext-ip` ],
				natWaitsForGroup: true
			};
		}

		expect(facts).toEqual(expected);
	});

	it('keeps the reserved address at its URN, with its inputs, so its IP does not change', async function() {
		const app = 'egress-address';
		const tree = await workerTree(app, { kind: 'mig', egress: 'vpc+nat' });
		const address = only(tree, ADDRESS);

		expect(address.urn).toBe(`urn:pulumi:${tree.stack}::${tree.project}::Keeta:GCP:CloudRunService$${ADDRESS}::${app}-mig-ext-ip`);
		expect(moveAliases(address)).toEqual([]);
		expect(address.inputs).toEqual({ addressType: 'EXTERNAL', description: `[${app}] External IP for MIG`, region: 'us-central1' });
	});

	/* The NAT serves the subnet of the worker alone: a NAT of the whole network fails where another NAT exists, and serves subnets that are not the worker's */
	it('scopes the NAT of the worker to its subnet, all IP ranges of it', async function() {
		const tree = await workerTree('egress-nat-shape', { kind: 'mig', egress: 'vpc+nat' });

		expect(optionalRecord(only(tree, NAT).inputs)).toMatchObject({
			region: 'us-central1',
			sourceSubnetworkIpRangesToNat: 'LIST_OF_SUBNETWORKS',
			subnetworks: [ { name: interfaceOf(tree).subnetwork, sourceIpRangesToNats: [ 'ALL_IP_RANGES' ] } ]
		});
	});

	/*
	 * Nothing outside the egress of the worker changes: against the same app
	 * on `vpc`, `vpc+direct` differs in the template alone, and `vpc+nat`
	 * adds the address and the NAT with its router and makes the group wait
	 * for its instances. The template of `vpc+nat` is the one of `vpc` (no
	 * access config, no `natIp`); it is a replacement only against 1.0.95,
	 * where it carried the `natIp`, which the test of its network interface
	 * above and the snapshot of `service-mig` show. Every other resource
	 * keeps its type, parent, aliases, inputs and dependencies.
	 */
	function summary(resource: TreeResource) {
		return(JSON.stringify([ resource.type, resource.parent, resource.aliases, resource.inputs, resource.dependsOn, resource.protect, resource.retainOnDelete, resource.deletedWith ]));
	}

	/* [ egress, the types that are added, the resources that change ] */
	const differences: [ Egress, string[], string[] ][] = [
		[ 'vpc+direct', [], [ TEMPLATE ] ],
		[ 'vpc+nat', [ ADDRESS, ROUTER, NAT ], [ MANAGER ] ]
	];

	it.each(differences)('differs from egress vpc, with %s, in the resources that the Design names only', async function(egress, added, changed) {
		const app = 'egress-diff';
		const before = await workerTree(app, { kind: 'mig', egress: 'vpc', instanceCount: 3 });
		const after = await workerTree(app, { kind: 'mig', egress, instanceCount: 3 });
		const known = new Map(before.resources.map(function(resource) {
			return([ resource.urn, resource ]);
		}));

		expect(after.resources.filter(function(resource) {
			return(!known.has(resource.urn));
		}).map(function(resource) {
			return(resource.type);
		}).sort()).toEqual([ ...added ].sort());
		expect(before.resources.filter(function(resource) {
			return(!after.resources.some(function(other) {
				return(other.urn === resource.urn);
			}));
		})).toEqual([]);
		expect(after.resources.filter(function(resource) {
			const earlier = known.get(resource.urn);

			return(earlier !== undefined && summary(earlier) !== summary(resource));
		}).map(function(resource) {
			return(resource.type);
		}).sort()).toEqual([ ...changed ].sort());
	});
});

/*
 * The router and the NAT of a worker pool move into `createCloudNat` and
 * keep their names, inputs and parent: the same resources, byte for byte.
 */
describe('egress of a Cloud Run worker pool', function() {
	useIsolatedHome();

	it('keeps the router and the NAT as they were', async function() {
		const app = 'egress-pool';
		const tree = await workerTree(app, { kind: 'crwp', egress: 'vpc+nat' });
		const router = only(tree, ROUTER);
		const nat = only(tree, NAT);
		const pool = expectDefined(ofType(tree, 'Keeta:GCP:ContainerCloudRun')[0], 'the worker pool component');
		const prefix = `urn:pulumi:${tree.stack}::${tree.project}::Keeta:GCP:CloudRunService$Keeta:GCP:ContainerCloudRun$`;

		expect([ router.urn, nat.urn ]).toEqual([ `${prefix}${ROUTER}::${app}-crwp-cloudnat-router`, `${prefix}${NAT}::${app}-crwp-cloudnat` ]);
		expect([ router.parent, nat.parent ]).toEqual([ pool.urn, pool.urn ]);
		expect(router.aliases).toEqual([]);
		expect(nat.aliases).toEqual([]);
		expect(router.inputs).toEqual({ description: `[${app}-crwp] Cloud NAT router for Cloud Run Worker Pool`, network: `self-link.${app}-vpc`, region: 'us-central1' });
		expect(nat.inputs).toEqual({ natIpAllocateOption: 'AUTO_ONLY', region: 'us-central1', router: `${app}-crwp-cloudnat-router`, sourceSubnetworkIpRangesToNat: 'ALL_SUBNETWORKS_ALL_IP_RANGES' });
		expect(nat.dependsOn).toContain(router.urn);
	});

	it.each([ 'vpc', 'vpc+direct' ] as const)('creates no router and no NAT with egress %s', async function(egress) {
		const tree = await workerTree(`egress-pool-${egress.replace('+', '-')}`, { kind: 'crwp', egress });

		expect([ ...ofType(tree, ROUTER), ...ofType(tree, NAT) ]).toEqual([]);
	});
});

/*
 * A subnet is served by one NAT, so an AppNetwork lets one worker claim
 * its NAT (a MIG or a pool with `vpc+nat`). A second claim is refused when
 * the service is built; separate AppNetworks have separate subnets.
 */
describe('workers with a NAT on a shared AppNetwork', function() {
	useIsolatedHome();

	type Worker = [ 'mig' | 'crwp', Egress, 0 | 1 ];

	/* [ description, the workers (kind, egress, the AppNetwork that the service is given), whether the second service is refused ] */
	const rows: [ string, Worker[], boolean ][] = [
		[ 'one MIG with vpc+nat', [ [ 'mig', 'vpc+nat', 0 ] ], false ],
		[ 'one worker pool with vpc+nat', [ [ 'crwp', 'vpc+nat', 0 ] ], false ],
		[ 'two MIGs with vpc+nat', [ [ 'mig', 'vpc+nat', 0 ], [ 'mig', 'vpc+nat', 0 ] ], true ],
		[ 'two worker pools with vpc+nat', [ [ 'crwp', 'vpc+nat', 0 ], [ 'crwp', 'vpc+nat', 0 ] ], true ],
		[ 'a MIG and a worker pool with vpc+nat', [ [ 'mig', 'vpc+nat', 0 ], [ 'crwp', 'vpc+nat', 0 ] ], true ],
		[ 'a MIG with vpc+nat and a MIG with vpc', [ [ 'mig', 'vpc+nat', 0 ], [ 'mig', 'vpc', 0 ] ], false ],
		[ 'a MIG with vpc+nat and a MIG with vpc+direct', [ [ 'mig', 'vpc+nat', 0 ], [ 'mig', 'vpc+direct', 0 ] ], false ],
		[ 'two workers with vpc+nat on different AppNetworks', [ [ 'mig', 'vpc+nat', 0 ], [ 'mig', 'vpc+nat', 1 ] ], false ]
	];

	it.each(rows)('with %s', async function(description, workers, refused) {
		const label = description.replace(/[^a-z]+/gi, '-').toLowerCase();
		const built = captureTree(function() {
			const networks = [ new AppNetwork(`${label}-one`, appNetworkArgs()), new AppNetwork(`${label}-two`, appNetworkArgs()) ] as const;

			workers.forEach(function([ kind, egress, which ], index) {
				buildService(`${label}-${index}`, { network: networks[which], worker: { kind, egress }});
			});
		});

		if (refused) {
			await expect(built).rejects.toBeInstanceOf(CloudRunServiceArgsError);
		} else {
			await expect(built).resolves.toBeDefined();
		}
	});
});

/* The egress of a worker is typed with the three ways, for both kinds, and for no other string */
describe('the type of worker.egress', function() {
	it('is the three ways for the container VM worker and for the worker pool, and no other string', function() {
		expectTypeOf<appsArgs.MigWorkerArgs['egress']>().toEqualTypeOf<Egress | undefined>();
		expectTypeOf<appsArgs.CrwpWorkerArgs['egress']>().toEqualTypeOf<Egress | undefined>();
		expectTypeOf<'bogus'>().not.toExtend<appsArgs.MigWorkerArgs['egress']>();
		expectTypeOf<'bogus'>().not.toExtend<appsArgs.CrwpWorkerArgs['egress']>();
	});
});
