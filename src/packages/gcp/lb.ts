import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';

import type { GCPCommonOptions } from './common';
import type { ContainerMIG } from './container';

type LoadBalancerArgs = {
	/**
	 * Common arguments for GCP resources
	 */
	common: {
		gcp: GCPCommonOptions;
	}

	/**
	 * Base description to build the description for the resources from
	 */
	baseDescription: string;

	/**
	 * Configuration for managing DNS entries
	 */
	dns?: {
		addEntry: (name: pulumi.Input<string>, kind: string, data: pulumi.Input<string>) => pulumi.Resource | void;
	};

	/**
	 * Load Balancer Health Check
	 */
	healthCheck: gcp.compute.HealthCheck;

	/**
	 * Enabling logging for the Load Balancer
	 *
	 * (Default is enabled)
	 */
	logging?: boolean;

	/**
	 * Target for the Internal Load Balancer
	 */
	target: Pick<ContainerMIG, 'instanceGroupManager' | 'serviceAccount' | 'subnetwork'>;

	/**
	 * Limit IPs that can access the Load Balancer
	 *
	 * (If not specified, the default is to allow all IPs)
	 */
	allowedSources?: pulumi.Input<string>[];

	/**
	 * Backend Service for the External Load Balancer
	 * configuration options
	 */
	backendConfig?: Omit<NonNullable<ConstructorParameters<typeof gcp.compute.BackendService>[1]>, 'backends' | 'loadBalancingScheme'>;
};

type InternalLoadBalancerArgs = LoadBalancerArgs & {
	/**
	 * Subnetwork to use for the Internal Load Balancer
	 */
	subnetwork: gcp.compute.Subnetwork;

	/**
	 * Proxy-only Subnetwork CIDR to use for the Internal
	 * Load Balancer.  It must be supplied in order to create
	 * the appropriate firewall rules.
	 *
	 * If "createProxySubnetwork" is specified as true then
	 * this will be used to create the proxy-only subnetwork.
	 *
	 * Proxy-only subnetworks are used by GCP for internal cross-region
	 * load balancing and are an artifact of this process -- only one
	 * should be created per subnetwork.
	 */
	proxySubnetworkCIDR: pulumi.Input<string>;

	/**
	 * Specify whether or not to create the proxy-only
	 * subnetwork
	 *
	 * Proxy-only subnetworks are used by GCP for internal cross-region
	 * load balancing and are an artifact of this process -- only one
	 * should be created per subnetwork.
	 *
	 * Default is false
	 */
	createProxySubnetwork?: boolean;

	/**
	 * IP Address to use for the Internal Load Balancer,
	 * if not supplied one will be created
	 */
	ip?: pulumi.Input<string> | gcp.compute.Address;

	/**
	 * Domain name to use for the SSL certificates and DNS
	 * entries (must be supplied if "sslCertificateName"
	 * is not)
	 */
	domainName?: pulumi.Input<string>;

	/**
	 * Name of the SSL certificate to use (if not
	 * supplied, one will be created using DNS validation
	 * of the domain name specified in "domainName")
	 */
	sslCertificateName?: pulumi.Input<string>;
};

type ExternalLoadBalancerArgs = LoadBalancerArgs & {
	/**
	 * IP Address to use for the Internal Load Balancer,
	 * if not supplied one will be created
	 */
	ip?: pulumi.Input<string> | gcp.compute.GlobalAddress;

	/**
	 * Domain name to use for the SSL certificates and DNS
	 * entries (must be supplied if "sslCertificateName"
	 * is not)
	 */
	domainName?: pulumi.Input<string>;

	/**
	 * Name of the SSL certificate to use (if not
	 * supplied, one will be created using DNS validation
	 * of the domain name specified in "domainName")
	 */
	sslCertificateName?: pulumi.Input<string>;
};

/**
 * Construct a Security Policy for the Backend Service based on the allowed sources
 */
function createBackendSecurityPolicy(name: string, allowedSources: LoadBalancerArgs['allowedSources'], args?: Omit<NonNullable<ConstructorParameters<typeof gcp.compute.SecurityPolicy>[1]>, 'rules'>, opts?: ConstructorParameters<typeof gcp.compute.SecurityPolicy>[2]) {
	if (allowedSources === undefined) {
		return(undefined);
	}

	const backendSecurityPolicy = new gcp.compute.SecurityPolicy(name, {
		rules: (function() {
			const rules: NonNullable<NonNullable<ConstructorParameters<typeof gcp.compute.SecurityPolicy>[1]>['rules']> = [];

			const sources = [...allowedSources];
			let offset = -1;
			while (sources.length > 0) {
				offset++;
				rules.push({
					priority: 1000 + offset,
					action: 'allow',
					match: {
						config: {
							srcIpRanges: sources.splice(0, 10)
						},
						versionedExpr: 'SRC_IPS_V1'
					}
				});
			}

			return(rules);
		})(),
		...args
	}, opts);

	return(backendSecurityPolicy);
}


/**
 * Internal load balancer (on the same subnet as the Managed Instance Group, or the specified subnet)
 */
export class InternalLoadBalancer extends pulumi.ComponentResource {
	readonly lb: gcp.compute.GlobalForwardingRule;
	readonly backend: gcp.compute.BackendService;

	constructor(name: string, args: InternalLoadBalancerArgs, opts?: pulumi.ComponentResourceOptions) {
		super('keeta:lb:InternalLoadBalancer', name, args, opts);
		const config = args;

		/**
		 * Load Balancer logging
		 */
		const loggingEnabled = args.logging ?? true;

		/**
		 * Region (must be the same for the Managed Instance Group,
		 * the Load Balancer, and the Subnet)
		 */
		const region = config.subnetwork.region;

		/**
		 * Subnetwork the Load Balancer will be deployed into
		 */
		const subnetwork = config.subnetwork;

		/**
		 * Collect resources that *must* be created before the ILB
		 */
		const toDependOn: pulumi.Resource[] = [];

		/**
		 * Get the IP Address to use for the Load Balancer (user-specified or
		 * created)
		 */
		let ip = config.ip;
		if (ip === undefined) {
			ip = new gcp.compute.Address(`${name}-ip`, {
				description: `IP Address for the ${args.baseDescription}`,
				region: region,
				addressType: 'INTERNAL',
				subnetwork: subnetwork.id
			}, {
				parent: this
			});
		}
		if (gcp.compute.Address.isInstance(ip)) {
			/*
			 * Add a DNS entry for the internal load balancer
			 */
			if ('domainName' in config && config.domainName !== undefined) {
				const entry = args.dns?.addEntry(config.domainName, 'A', ip.address);
				if (entry !== undefined) {
					toDependOn.push(entry);
				}
			}

			ip = ip.id;
		}

		/*
		 * Create the proxy-only subnet if needed
		 */
		if ('createProxySubnetwork' in config && config.createProxySubnetwork === true) {
			const proxySubnetwork = new gcp.compute.Subnetwork(`${name}-proxy-subnetwork`, {
				description: `Proxy-only Subnetwork for the ${args.baseDescription}`,
				ipCidrRange: config.proxySubnetworkCIDR,
				network: subnetwork.network,
				region: subnetwork.region,
				purpose: 'GLOBAL_MANAGED_PROXY',
				role: 'ACTIVE'
			}, {
				parent: this
			});

			toDependOn.push(proxySubnetwork);
		}

		/*
		 * Pull in user-specified SSL certificate or create one
		 */
		let certificateID: pulumi.Output<string>;
		if ('sslCertificateName' in config && config.sslCertificateName !== undefined) {
			/* Untested */
			const cert = gcp.compute.getRegionSslCertificateOutput({
				name: config.sslCertificateName,
				region: region
			});

			certificateID = cert.apply(function(certInfo) {
				return(certInfo.id);
			});
		} else if ('domainName' in config && config.domainName !== undefined) {
			const domainValidation = new gcp.certificatemanager.DnsAuthorization(`${name}-cert-dns`, {
				description: `DNS Authorization for the SSL Certificate for the ${args.baseDescription}`,
				domain: config.domainName
			}, {
				parent: this
			});

			const dnsEntry = pulumi.output(domainValidation.dnsResourceRecords[0]);
			const entry = args.dns?.addEntry(dnsEntry.name, 'CNAME', dnsEntry.data);
			if (entry !== undefined) {
				toDependOn.push(entry);
			}

			const cert = new gcp.certificatemanager.Certificate(`${name}-cert`, {
				description: `SSL Certificate for the ${args.baseDescription}`,
				scope: 'ALL_REGIONS',
				managed: {
					domains: [config.domainName],
					dnsAuthorizations: [domainValidation.id]
				}
			}, {
				parent: domainValidation,
				dependsOn: toDependOn.splice(0)
			});

			certificateID = cert.id;
		} else {
			throw(new Error('Internal Load Balancer requires either a domain name or an SSL certificate name (or both)'));
		}

		const backendSecurityPolicy = createBackendSecurityPolicy(`${name}-ext-be-sp`, args.allowedSources, undefined, {
			parent: this
		});

		const backend = new gcp.compute.BackendService(`${name}-be`, {
			backends: [{
				description: `Backend for the ${args.baseDescription}`,
				group: args.target.instanceGroupManager.instanceGroup
			}],
			healthChecks: args.healthCheck.selfLink,
			loadBalancingScheme: 'INTERNAL_MANAGED',
			logConfig: {
				enable: loggingEnabled
			},
			securityPolicy: backendSecurityPolicy?.id,
			...args.backendConfig
		}, {
			parent: this
		});

		const urlMap = new gcp.compute.URLMap(`${name}-map`, {
			description: `URL Map for the ${args.baseDescription}`,
			defaultService: backend.selfLink
		}, {
			parent: backend
		});

		const target = new gcp.compute.TargetHttpsProxy(`${name}-target`, {
			description: `Target HTTPS Proxy for the ${args.baseDescription}`,
			urlMap: urlMap.name,
			certificateManagerCertificates: [certificateID]
		}, {
			parent: urlMap
		});

		const lb = new gcp.compute.GlobalForwardingRule(`${name}-ilb`, {
			description: `Internal Load Balancer for ${args.baseDescription}`,
			target: target.id,
			loadBalancingScheme: 'INTERNAL_MANAGED',
			ipAddress: ip,
			portRange: '443',
			subnetwork: subnetwork.id,
			network: subnetwork.network
		}, {
			parent: urlMap,
			dependsOn: toDependOn.splice(0)
		});

		/*
		 * Firewall to allow traffic from the ILB inbound
		 * https://cloud.google.com/load-balancing/docs/firewall-rules
		 */
		new gcp.compute.Firewall(`${name}-ilb-in`, {
			description: `Inbound firewall rule for the ${args.baseDescription}`,
			direction: 'INGRESS',
			network: pulumi.output(args.target.subnetwork).network,
			allows: [{
				protocol: 'tcp',
				ports: ['8080', '80', '443']
			}],
			targetServiceAccounts: pulumi.output(args.target.serviceAccount).apply(function(serviceAccount) {
				if (gcp.serviceaccount.Account.isInstance(serviceAccount)) {
					return([serviceAccount.email]);
				} else {
					return([serviceAccount]);
				}
			}),
			sourceRanges: [config.proxySubnetworkCIDR, '35.191.0.0/16', '130.211.0.0/22'],
			priority: 900,
			...args.common.gcp.firewallConfig
		}, {
			parent: lb
		});

		new gcp.compute.Firewall(`${name}-ilb-in-health`, {
			description: `Inbound firewall rule for the ${args.baseDescription} ILB Health Check`,
			direction: 'INGRESS',
			network: subnetwork.network,
			allows: [{
				protocol: 'tcp',
				ports: ['443', '8080', '80']
			}],
			destinationRanges: [lb.ipAddress],
			sourceRanges: ['35.191.0.0/16', '130.211.0.0/22'],
			priority: 900,
			...args.common.gcp.firewallConfig
		}, {
			parent: lb
		});

		this.lb = lb;
		this.backend = backend;
	}
}

export class ExternalLoadBalancer extends pulumi.ComponentResource {
	readonly lb: gcp.compute.GlobalForwardingRule;
	readonly backend: gcp.compute.BackendService;

	constructor(name: string, args: ExternalLoadBalancerArgs, opts?: pulumi.ComponentResourceOptions) {
		super('keeta:lb:ExternalLoadBalancer', name, args, opts);

		const config = args;

		/**
		 * Load Balancer logging
		 */
		const loggingEnabled = args.logging ?? true;

		/**
		 * Collect resources that *must* be created before the ILB
		 */
		const toDependOn: pulumi.Resource[] = [];

		/**
		 * Get the IP Address to use for the Load Balancer (user-specified or
		 * created)
		 */
		let ip = config.ip;
		if (ip === undefined) {
			ip = new gcp.compute.GlobalAddress(`${name}-ext-ip`, {
				description: `IP Address for the ${args.baseDescription}`,
				addressType: 'EXTERNAL'
			}, {
				parent: this
			});
		}
		if (gcp.compute.GlobalAddress.isInstance(ip)) {
			/*
			 * Add a DNS entry for the internal load balancer
			 */
			if ('domainName' in config && config.domainName !== undefined) {
				const entry = args.dns?.addEntry(config.domainName, 'A', ip.address);
				if (entry !== undefined) {
					toDependOn.push(entry);
				}
			}

			ip = ip.id;
		}

		/*
		 * Pull in user-specified SSL certificate or create one
		 */
		let certificateID: pulumi.Output<string>;
		if ('sslCertificateName' in config && config.sslCertificateName !== undefined) {
			certificateID = pulumi.output(config.sslCertificateName);
		} else if ('domainName' in config && config.domainName !== undefined) {
			const cert = new gcp.compute.ManagedSslCertificate(`${name}-ext-cert`, {
				description: `SSL Certificate for the ${args.baseDescription}`,
				managed: {
					domains: [config.domainName]
				}
			}, {
				parent: this,
				dependsOn: toDependOn.splice(0)
			});

			certificateID = cert.id;
		} else {
			throw(new Error('External Load Balancer requires either a domain name or an SSL certificate name (or both)'));
		}

		const backendSecurityPolicy = createBackendSecurityPolicy(`${name}-ext-be-sp`, args.allowedSources, undefined, {
			parent: this
		});

		const backend = new gcp.compute.BackendService(`${name}-ext-be`, {
			backends: [{
				description: `Backend for the ${args.baseDescription}`,
				group: args.target.instanceGroupManager.instanceGroup
			}],
			healthChecks: args.healthCheck.selfLink,
			loadBalancingScheme: 'EXTERNAL_MANAGED',
			logConfig: {
				enable: loggingEnabled
			},
			securityPolicy: backendSecurityPolicy?.id,
			...args.backendConfig
		}, {
			parent: this
		});

		const urlMap = new gcp.compute.URLMap(`${name}-ext-map`, {
			description: `URL Map for the ${args.baseDescription}`,
			defaultService: backend.selfLink
		}, {
			parent: backend
		});

		const target = new gcp.compute.TargetHttpsProxy(`${name}-ext-target`, {
			description: `Target HTTPS Proxy for the ${args.baseDescription}`,
			urlMap: urlMap.name,
			sslCertificates: [certificateID]
		}, {
			parent: urlMap
		});

		const lb = new gcp.compute.GlobalForwardingRule(`${name}-lb`, {
			description: `External Load Balancer for the ${args.baseDescription}`,
			target: target.id,
			loadBalancingScheme: 'EXTERNAL_MANAGED',
			ipAddress: ip,
			portRange: '443'
		}, {
			parent: urlMap,
			dependsOn: toDependOn.splice(0)
		});

		/*
		 * Firewall to allow traffic from the LB inbound
		 * https://cloud.google.com/load-balancing/docs/firewall-rules
		 */
		new gcp.compute.Firewall(`${name}-lb-in`, {
			description: `Inbound firewall rule for the ${args.baseDescription} from LB`,
			direction: 'INGRESS',
			network: pulumi.output(args.target.subnetwork).network,
			allows: [{
				protocol: 'tcp',
				ports: ['8080']
			}],
			targetServiceAccounts: pulumi.output(args.target.serviceAccount).apply(function(serviceAccount) {
				if (gcp.serviceaccount.Account.isInstance(serviceAccount)) {
					return([serviceAccount.email]);
				} else {
					return([serviceAccount]);
				}
			}),
			sourceRanges: ['35.191.0.0/16', '130.211.0.0/22'],
			priority: 900,
			...args.common.gcp.firewallConfig
		}, {
			parent: lb
		});

		this.lb = lb;
		this.backend = backend;
	}
}
