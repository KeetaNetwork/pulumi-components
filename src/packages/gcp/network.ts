import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import type { GCPRegion } from './constants';
import { legacyUrn, movedFrom } from './aliases';
import type { OldParent } from './aliases';
import { generateName } from '../../utils';

const NETWORK_TYPE = 'gcp:compute/network:Network';
const SUBNETWORK_TYPE = 'gcp:compute/subnetwork:Subnetwork';
const CONNECTOR_TYPE = 'gcp:vpcaccess/connector:Connector';
const ADDRESS_TYPE = 'gcp:compute/globalAddress:GlobalAddress';
const CONNECTION_TYPE = 'gcp:servicenetworking/connection:Connection';
const FIREWALL_TYPE = 'gcp:compute/firewall:Firewall';

export interface AppNetworkArgs {
	region: GCPRegion;

	/**
	 * A VPC of the caller. It is used as it is: the component never makes it
	 * its child, and never changes it.
	 */
	network?: gcp.compute.Network;

	subnetCIDR: string;
	connectorCIDR: string;
	connector: {
		minInstances: number;
		maxInstances: number;
	};

	/** Prefix length of the private service access range that a database is reached through */
	psaPrefixLength: number;

	/**
	 * Deletion policy for the service networking connection.
	 * Set to 'ABANDON' to avoid delete failures when Cloud SQL hasn't released the connection.
	 */
	servicePeeringDeletionPolicy?: 'ABANDON';

	/**
	 * The URN of the app whose network resources these were in 1.0.95
	 * (`CloudRunService` passes its own for the network that it builds for
	 * itself). They answer to the URN they had then (they were children of
	 * the app, or of the VPC of the caller), and `name` is the name of the
	 * app. To adopt a shared network without replacing anything, build the
	 * `AppNetwork` with the name of the app whose own network it takes over
	 * and pass that app's old URN here.
	 */
	movedFrom?: pulumi.Input<pulumi.URN>;
}

export interface IapSshFirewallArgs {
	/** The source range of IAP */
	sourceRange: string;
	priority: number;

	/** Anything else the caller wants on the firewall (`GCPCommonOptions.firewallConfig`) */
	extra?: Partial<gcp.compute.FirewallArgs>;
}

/**
 * The network of one or more apps: the VPC (or the VPC of the caller), the
 * subnet, the VPC connector, and the one private service access connection
 * that a network may have (a second `servicenetworking.Connection` for the
 * same network and service is an error in GCP). Apps that share a network
 * receive the same `AppNetwork`, so the connection is made once.
 *
 * The connection (with its address range) is made the first time a database
 * asks for it, with `privateServiceAccess()`.
 */
export class AppNetwork extends pulumi.ComponentResource {
	/** The VPC: the one of the caller, or the one made here */
	readonly network: gcp.compute.Network;
	readonly subnet: gcp.compute.Subnetwork;
	readonly connector: gcp.vpcaccess.Connector;

	/** The region of the subnet and the connector: an app in another region cannot use them */
	readonly region: GCPRegion;

	readonly #name: string;
	readonly #args: AppNetworkArgs;
	readonly #oldNetwork?: OldParent;
	#privateServiceAccess?: gcp.servicenetworking.Connection;
	#natWorker = false;

	/**
	 * @param name Prefix of the resources: `${name}-vpc`, `${name}-subnet` and
	 * so on. The component is `${name}-network`.
	 */
	constructor(name: string, args: AppNetworkArgs, opts?: pulumi.ComponentResourceOptions) {
		super('Keeta:GCP:AppNetwork', `${name}-network`, {}, opts);

		this.#name = name;
		this.#args = args;
		this.region = args.region;

		const app = args.movedFrom;
		let ownNetworkAliases: pulumi.Output<pulumi.URN>[] | undefined;
		if (args.network !== undefined) {
			this.network = args.network;
			if (app !== undefined) {
				this.#oldNetwork = { kind: 'resource', urn: args.network.urn };
			}
		} else {
			if (app !== undefined) {
				ownNetworkAliases = movedFrom(`${name}-vpc`, NETWORK_TYPE, { kind: 'resource', urn: app });
				this.#oldNetwork = { kind: 'resource', urn: legacyUrn(`${name}-vpc`, NETWORK_TYPE, { kind: 'resource', urn: app }) };
			}

			this.network = new gcp.compute.Network(`${name}-vpc`, {
				description: `[${name}] VPC network`,
				autoCreateSubnetworks: false
			}, { parent: this, aliases: ownNetworkAliases });
		}

		let subnetAliases: pulumi.Output<pulumi.URN>[] | undefined;
		let connectorAliases: pulumi.Output<pulumi.URN>[] | undefined;
		if (this.#oldNetwork !== undefined) {
			subnetAliases = movedFrom(`${name}-subnet`, SUBNETWORK_TYPE, this.#oldNetwork);
			const oldSubnet: OldParent = { kind: 'resource', urn: legacyUrn(`${name}-subnet`, SUBNETWORK_TYPE, this.#oldNetwork) };
			connectorAliases = movedFrom(`${name}-vpc-connector`, CONNECTOR_TYPE, oldSubnet);
		}

		this.subnet = new gcp.compute.Subnetwork(`${name}-subnet`, {
			description: `[${name}] Subnet`,
			network: this.network.selfLink,
			region: args.region,
			ipCidrRange: args.subnetCIDR,
			privateIpGoogleAccess: true
		}, { parent: this, aliases: subnetAliases });

		this.connector = new gcp.vpcaccess.Connector(`${name}-vpc-connector`, {
			name: generateName(name, 'vpc', 25),
			ipCidrRange: args.connectorCIDR,
			minInstances: args.connector.minInstances,
			maxInstances: args.connector.maxInstances,
			network: this.network.selfLink,
			region: args.region
		}, { parent: this, aliases: connectorAliases });

		this.registerOutputs({ network: this.network, subnet: this.subnet, connector: this.connector });
	}

	/**
	 * Claims the Cloud NAT of the network for a worker (`egress: 'vpc+nat'`).
	 * GCP allows one NAT to serve a subnet. The NAT of a MIG serves only the
	 * subnet of the worker, but the NAT of a Cloud Run worker pool covers
	 * every subnet of the network and region, so a network has one worker with
	 * a NAT, like it has one connection.
	 *
	 * @returns false when another worker already has it
	 */
	claimNatWorker(): boolean {
		if (this.#natWorker) {
			return(false);
		}

		this.#natWorker = true;

		return(true);
	}

	/**
	 * The private service access connection of the network, made on the
	 * first call and the same one after that: a database reaches its private
	 * IP through it.
	 */
	privateServiceAccess(): gcp.servicenetworking.Connection {
		if (this.#privateServiceAccess !== undefined) {
			return(this.#privateServiceAccess);
		}

		const name = this.#name;
		let allocAliases: pulumi.Output<pulumi.URN>[] | undefined;
		let connectionAliases: pulumi.Output<pulumi.URN>[] | undefined;
		if (this.#oldNetwork !== undefined) {
			allocAliases = movedFrom(`${name}-private-ip-alloc`, ADDRESS_TYPE, this.#oldNetwork);
			const oldAlloc: OldParent = { kind: 'resource', urn: legacyUrn(`${name}-private-ip-alloc`, ADDRESS_TYPE, this.#oldNetwork) };
			connectionAliases = movedFrom(`${name}-svc-networking`, CONNECTION_TYPE, oldAlloc);
		}

		const privateIpAlloc = new gcp.compute.GlobalAddress(`${name}-private-ip-alloc`, {
			purpose: 'VPC_PEERING',
			addressType: 'INTERNAL',
			prefixLength: this.#args.psaPrefixLength,
			network: this.network.selfLink
		}, { parent: this, aliases: allocAliases });

		this.#privateServiceAccess = new gcp.servicenetworking.Connection(`${name}-svc-networking`, {
			network: this.network.selfLink,
			service: 'servicenetworking.googleapis.com',
			reservedPeeringRanges: [privateIpAlloc.name],
			deletionPolicy: this.#args.servicePeeringDeletionPolicy
		}, { parent: this, aliases: connectionAliases });

		return(this.#privateServiceAccess);
	}

	/**
	 * The firewall that lets IAP reach port 22 of the instances of the network,
	 * named `${appName}-ssh-iap-firewall` after the app that asks for it.
	 */
	allowIapSsh(appName: string, args: IapSshFirewallArgs): gcp.compute.Firewall {
		const firewallName = `${appName}-ssh-iap-firewall`;
		let aliases: pulumi.Output<pulumi.URN>[] | undefined;
		if (this.#oldNetwork !== undefined && appName === this.#name) {
			aliases = movedFrom(firewallName, FIREWALL_TYPE, this.#oldNetwork);
		}

		return(new gcp.compute.Firewall(firewallName, {
			description: `[${appName}] Allow SSH access to MIG instances via IAP`,
			network: this.network.id,
			direction: 'INGRESS',
			sourceRanges: [args.sourceRange],
			priority: args.priority,
			allows: [{
				protocol: 'tcp',
				ports: ['22']
			}],
			...args.extra
		}, { parent: this, aliases }));
	}
}
