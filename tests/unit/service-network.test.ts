import * as gcp from '@pulumi/gcp';
import { describe, expect, it } from 'vitest';

import { expectDefined } from '../helpers/narrow';
import { captureTree, moveAliases, ofType, useIsolatedHome } from './harness/pulumi-tree';
import { buildService } from './harness/service-builder';
import { captureWarningsAsync } from './harness/warnings';

const APP_NETWORK = 'Keeta:GCP:AppNetwork';
const CONNECTION = 'gcp:servicenetworking/connection:Connection';
const NETWORK = 'gcp:compute/network:Network';
const SUBNETWORK = 'gcp:compute/subnetwork:Subnetwork';
const ADDRESS = 'gcp:compute/globalAddress:GlobalAddress';

/*
 * Uniqueness of a connection across separately built services is not
 * visible to any one of them (I-psa-vpc, a convention): the legacy path
 * still builds one AppNetwork for each service, and says so.
 */
describe('services that share a VPC of the caller without an AppNetwork', function() {
	useIsolatedHome();

	function sharedVpc(name: string) {
		return(captureTree(function() {
			const callerNetwork = new gcp.compute.Network(`${name}-vpc-of-caller`, { autoCreateSubnetworks: false });
			buildService(`${name}-a`, { vpc: { network: callerNetwork }, database: {}});
		}));
	}

	it('warns, naming AppNetwork, once for each service that builds a network from a VPC', async function() {
		const { warnings } = await captureWarningsAsync(function() {
			return(sharedVpc('legacy-warn'));
		});

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/AppNetwork/);
	});

	it('does not warn about a network that the service creates for itself', async function() {
		const { warnings } = await captureWarningsAsync(function() {
			return(captureTree(function() {
				return(buildService('own-network', { database: {}}));
			}));
		});

		expect(warnings).toEqual([]);
	});

	function twoServices() {
		return(captureTree(function() {
			const callerNetwork = new gcp.compute.Network('legacy-vpc', { autoCreateSubnetworks: false });
			buildService('legacy-a', { vpc: { network: callerNetwork }, database: {}});
			buildService('legacy-b', { vpc: { network: callerNetwork }, database: {}});
		}));
	}

	it('still gives each of two services its own connection (B13 stays reachable on this path)', async function() {
		expect(ofType(await twoServices(), CONNECTION)).toHaveLength(2);
	});

	it('builds one AppNetwork for each of them', async function() {
		expect(ofType(await twoServices(), APP_NETWORK).map(function(resource) {
			return(resource.name);
		}).sort()).toEqual([ 'legacy-a-network', 'legacy-b-network' ]);
	});
});

/*
 * The cases of the URN baseline have a caller network only for a service
 * without a worker, so the aliases of the rest of the chain are computed
 * here from the shape of the released URNs: the old parent is the network
 * of the caller, a root resource.
 */
describe('a service on the network of the caller', function() {
	useIsolatedHome();

	/* [ the name of the resource, its type, the type chain of its URN in 1.0.95 ] */
	const chains: [ string, string, string ][] = [
		[ 'subnet', SUBNETWORK, `${NETWORK}$${SUBNETWORK}` ],
		[ 'vpc-connector', 'gcp:vpcaccess/connector:Connector', `${NETWORK}$${SUBNETWORK}$gcp:vpcaccess/connector:Connector` ],
		[ 'private-ip-alloc', ADDRESS, `${NETWORK}$${ADDRESS}` ],
		[ 'svc-networking', CONNECTION, `${NETWORK}$${ADDRESS}$${CONNECTION}` ],
		[ 'ssh-iap-firewall', 'gcp:compute/firewall:Firewall', `${NETWORK}$gcp:compute/firewall:Firewall` ]
	];

	it.each(chains)('moves the %s to the AppNetwork with one alias: its URN under the network of the caller', async function(ending, type, chain) {
		const app = `caller-chain-${ending}`;
		const tree = await captureTree(function() {
			const callerNetwork = new gcp.compute.Network(`${app}-vpc-of-caller`, { autoCreateSubnetworks: false });
			buildService(app, { vpc: { network: callerNetwork }, database: {}, worker: { kind: 'mig', enableSSH: true }});
		});
		const resource = expectDefined(tree.resources.find(function(candidate) {
			return(candidate.name === `${app}-${ending}` && candidate.type === type);
		}), `the ${ending}`);
		const parent = tree.resources.find(function(candidate) {
			return(candidate.urn === resource.parent);
		});

		expect(parent?.type).toBe(APP_NETWORK);
		expect(parent?.name).toBe(`${app}-network`);
		expect(moveAliases(resource)).toEqual([ `urn:pulumi:${tree.stack}::${tree.project}::${chain}::${app}-${ending}` ]);
	});

	it('never re-parents the network of the caller', async function() {
		const app = 'caller-chain-network';
		const tree = await captureTree(function() {
			const callerNetwork = new gcp.compute.Network(`${app}-vpc-of-caller`, { autoCreateSubnetworks: false });
			buildService(app, { vpc: { network: callerNetwork }, database: {}});
		});
		const caller = expectDefined(ofType(tree, NETWORK).find(function(resource) {
			return(resource.name === `${app}-vpc-of-caller`);
		}), 'the network of the caller');

		expect(caller.parent).toBeUndefined();
		expect(moveAliases(caller)).toEqual([]);
		expect(ofType(tree, NETWORK)).toHaveLength(1);
	});
});
