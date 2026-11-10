import * as gcp from '@pulumi/gcp';
import { describe, expect, it } from 'vitest';

import type * as network from '../../src/packages/gcp/network';
import { expectDefined } from '../helpers/narrow';
import { requireSource } from './harness/load-sources';
import { captureTree, moveAliases, ofType, useIsolatedHome } from './harness/pulumi-tree';
import { appNetworkArgs, buildService } from './harness/service-builder';
import { captureWarnings } from './harness/warnings';

const { AppNetwork } = requireSource<typeof network>('src/packages/gcp/network.ts');

const APP_NETWORK = 'Keeta:GCP:AppNetwork';
const CONNECTION = 'gcp:servicenetworking/connection:Connection';
const NETWORK = 'gcp:compute/network:Network';


const NETWORK_RESOURCES = [ '-vpc', '-subnet', '-vpc-connector', '-private-ip-alloc', '-svc-networking' ];

/*
 * A network has one private service access connection, and that is a
 * property of the AppNetwork, not of the services that use it (B13).
 */
describe('services that share an AppNetwork', function() {
	useIsolatedHome();

	it('create one servicenetworking connection between them, and no network resource of their own', async function() {
		const tree = await captureTree(function() {
			const shared = new AppNetwork('shared', appNetworkArgs());
			buildService('sharing-a', { network: shared, database: {}});
			buildService('sharing-b', { network: shared, database: {}});
		});

		expect(ofType(tree, APP_NETWORK)).toHaveLength(1);
		expect(ofType(tree, CONNECTION)).toHaveLength(1);
		expect(ofType(tree, 'gcp:sql/databaseInstance:DatabaseInstance').filter(function(instance) {
			return(instance.name.endsWith('-master'));
		}).map(function(instance) {
			return(instance.name);
		}).sort()).toEqual([ 'sharing-a-db-master', 'sharing-b-db-master' ]);
		expect(tree.resources.filter(function(resource) {
			return([ 'sharing-a', 'sharing-b' ].some(function(app) {
				return(NETWORK_RESOURCES.some(function(ending) {
					return(resource.name === `${app}${ending}`);
				}));
			}));
		})).toEqual([]);
	});

	it('create no network resource of their own when the network is a VPC of the caller too', async function() {
		const tree = await captureTree(function() {
			const callerNetwork = new gcp.compute.Network('caller-vpc', { autoCreateSubnetworks: false });
			const shared = new AppNetwork('shared-caller', { ...appNetworkArgs(), network: callerNetwork });
			buildService('sharing-caller-a', { network: shared, database: {}});
		});
		const caller = expectDefined(ofType(tree, NETWORK).find(function(resource) {
			return(resource.name === 'caller-vpc');
		}), 'the network of the caller');

		expect(ofType(tree, NETWORK)).toHaveLength(1);
		expect(caller.parent).toBeUndefined();
		expect(moveAliases(caller)).toEqual([]);
		expect(ofType(tree, CONNECTION)).toHaveLength(1);
	});

	it('do not warn', async function() {
		const { warnings } = await captureWarnings(function() {
			return(captureTree(function() {
				const shared = new AppNetwork('shared-quiet', appNetworkArgs());
				buildService('quiet-a', { network: shared, database: {}});
			}));
		});

		expect(warnings).toEqual([]);
	});
});
