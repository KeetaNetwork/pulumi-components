import type * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { generateName } from '../../utils';

type GooglePrivateIPAccessArgs = {
	/**
	 * The Network for which Google Private IP Access should be configured
	 */
	network: gcp.compute.Network;

	/**
	 * The subnets of the `network` which should be allowed to use Google Private IP Access
	 */
	subnets: gcp.compute.Subnetwork[];

	/**
	 * Whether to include the route to the restricted IPs -- if no default
	 * route is present on the subnets then this should be set to `true`
	 */
	includeRoute?: boolean;

	/**
	 * Common GCP configuration
	 */
	gcp?: {
		/**
		 * Configuration for the firewall rules created by this module
		 */
		firewallConfig?: Partial<ConstructorParameters<typeof gcp.compute.Firewall>[1]>;
	};
};

/**
 * Add a VPC network and its subnets to the list of subnets which can use
 * Google Private IP Access using the restricted IPs.
 *
 * This mutates `state` and it is expected that the state is passed to
 * `applyGooglePrivateIPAccess` to apply the changes.
 *
 * https://cloud.google.com/vpc/docs/configure-private-google-access
 *
 * @param name The base name for the resources
 * @param state The state to mutate
 * @param args The arguments for the Google Private IP Access
 */
export function addGooglePrivateIPAccessNetwork(name: string, state: Set<gcp.compute.Network>, args: GooglePrivateIPAccessArgs) {
	const network = args.network;

	/*
	 * Allow HTTPS outbound to GCP via Private IP Access
	 */
	new gcp.compute.Firewall(`${name}-firewall-gcp-out`, {
		description: 'Allow HTTPS outbound to GCP (Restricted)',
		network: network.id,
		direction: 'EGRESS',
		allows: [{
			protocol: 'tcp',
			ports: ['443']
		}],
		sourceRanges: args.subnets.map(function(subnet) {
			return(subnet.ipCidrRange);
		}),
		destinationRanges: ['199.36.153.4/30', '34.126.0.0/18'],
		priority: 900,
		...args.gcp?.firewallConfig
	}, {
		parent: network
	});

	if (args.includeRoute === true) {
		/*
		 * Route to GCP via Private IP Access
		 */
		new gcp.compute.Route(`${name}-route-gcp-range1`, {
			network: network.id,
			destRange: '199.36.153.4/30',
			priority: 999,
			nextHopGateway: 'default-internet-gateway'
		}, {
			parent: network
		});

		new gcp.compute.Route(`${name}-route-gcp-range2`, {
			network: network.id,
			destRange: '34.126.0.0/18',
			priority: 1,
			nextHopGateway: 'default-internet-gateway'
		}, {
			parent: network
		});
	}

	state.add(network);

	return(state);
}

/**
 * Apply "state" for Google Private IP Access, which should have been created
 * using `addGooglePrivateIPAccessNetwork`
 *
 * https://cloud.google.com/vpc/docs/configure-private-google-access
 *
 * @param name The base name for the resources
 * @param state The state to apply
 * @param parent The parent resource for the resources
 */
export function applyGooglePrivateIPAccess(name: string, state: Set<gcp.compute.Network>, parent?: pulumi.Resource) {
	/*
	 * If there are no networks to apply Google Private IP Access to, then
	 * we can skip this step
	 */
	if (state.size === 0) {
		return;
	}

	/**
	 * The networks to apply support for Google Private IP Access to
	 */
	const networks = [...state.values()];

	/**
	 * The set of IPs which we will resolve to the restricted IPs
	 */
	const GCPRestrictedIPv4Addresses = ['199.36.153.4', '199.36.153.5', '199.36.153.6', '199.36.153.7'];

	/**
	 * Zones for which we must create to resolve to the restricted IPs
	 */
	const zoneNames = ['googleapis.com.', 'gcr.io.', 'gstatic.com.', 'pkg.dev.', 'pki.goog.', 'run.app.'] as const;

	/**
	 * The main DNS zone for the restricted IPs, so we can configure the
	 * other zones to be the child of this zone
	 */
	let mainDNSZone: gcp.dns.ManagedZone | undefined;

	/**
	 * For each zone name construct a DNS zone and store that information
	 * to later create the records
	 */
	const zones = Object.fromEntries(zoneNames.map(function(zoneName): [typeof zoneName, { zone: gcp.dns.ManagedZone, name: string; }] {
		const zoneNameSanitized = zoneName.replace(/\./g, '-').replace(/-$/, '');

		const resourceName = `${name}-dns-zone-${zoneNameSanitized}`;
		const zone = new gcp.dns.ManagedZone(resourceName, {
			name: generateName(resourceName, 'zone', 63),
			description: `Private DNS Zone for Private IP access to Google APIs (${zoneName})`,
			dnsName: zoneName,
			visibility: 'private',
			privateVisibilityConfig: {
				networks: networks.map(function(network) {
					return({
						networkUrl: network.id
					});
				})
			}
		}, {
			parent: mainDNSZone ?? parent
		});

		if (zoneName === 'googleapis.com.') {
			mainDNSZone = zone;
		}

		return([zoneName, {
			zone: zone,
			name: zoneNameSanitized
		}]);
	}));

	/**
	 * Create the DNS entries in each zone to resolve to the restricted IPs
	 */
	for (const [zoneName, zoneInfo] of Object.entries(zones)) {
		let mainDNSEntryName = zoneName;

		/*
		 * For the googleapis.com zone, we need to use the
		 * restricted.googleapis.com DNS entry as the "main"
		 * entry (i.e., the one that resolves to the restricted IPs)
		 */
		if (zoneName === 'googleapis.com.') {
			mainDNSEntryName = 'restricted.googleapis.com.';
		}

		const zoneNameSanitized = zoneInfo.name;
		const zone = zoneInfo.zone;

		const mainDNSEntryForZone = new gcp.dns.RecordSet(`${name}-dns-rr-${zoneNameSanitized}-main`, {
			managedZone: zone.name,
			name: mainDNSEntryName,
			type: 'A',
			rrdatas: GCPRestrictedIPv4Addresses
		}, {
			parent: zone
		});

		new gcp.dns.RecordSet(`${name}-dns-rr-${zoneNameSanitized}-cname`, {
			managedZone: zone.name,
			name: `*.${zoneName}`,
			type: 'CNAME',
			rrdatas: [mainDNSEntryName]
		}, {
			parent: mainDNSEntryForZone
		});
	}

	state.clear();

	return(state);
}

