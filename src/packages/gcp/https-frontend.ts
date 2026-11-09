import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import type { IPAddressConfig, LoadBalancerConfig } from './apps';
import { legacyUrn, movedFrom } from './aliases';
import { FRONT_END_DEFAULTS } from './defaults';

const URL_MAP_TYPE = 'gcp:compute/uRLMap:URLMap';
const CERTIFICATE_MAP_TYPE = 'gcp:certificatemanager/certificateMap:CertificateMap';
const CERTIFICATE_MAP_ENTRY_TYPE = 'gcp:certificatemanager/certificateMapEntry:CertificateMapEntry';
const HTTPS_PROXY_TYPE = 'gcp:compute/targetHttpsProxy:TargetHttpsProxy';
const FORWARDING_RULE_TYPE = 'gcp:compute/globalForwardingRule:GlobalForwardingRule';

/**
 * Create HTTP-to-HTTPS redirect resources (URL map, proxy, forwarding rules)
 */
export function createHttpRedirect(
	name: string,
	ips: { ip: pulumi.Input<string>; kind: string }[],
	opts: {
		parent: pulumi.Resource;

		/**
		 * The URN of the resource that was their parent in 1.0.95, for
		 * resources that moved to `parent`: each answers to its old URN
		 */
		oldParent?: pulumi.Input<pulumi.URN>;
	}
) {
	function optionsOf(resourceName: string, type: string): pulumi.CustomResourceOptions {
		if (opts.oldParent === undefined) {
			return({ parent: opts.parent });
		}

		return({ parent: opts.parent, aliases: movedFrom(resourceName, type, { kind: 'resource', urn: opts.oldParent }) });
	}

	const redirectMap = new gcp.compute.URLMap(`${name}-http-redirect`, {
		defaultUrlRedirect: {
			httpsRedirect: true,
			stripQuery: false
		}
	}, optionsOf(`${name}-http-redirect`, URL_MAP_TYPE));

	const httpProxy = new gcp.compute.TargetHttpProxy(`${name}-http-proxy`, {
		urlMap: redirectMap.id
	}, optionsOf(`${name}-http-proxy`, 'gcp:compute/targetHttpProxy:TargetHttpProxy'));

	for (const ipConfig of ips) {
		const ruleName = `${name}-http-fr-${ipConfig.kind}`.replace(/-$/, '');
		new gcp.compute.GlobalForwardingRule(ruleName, {
			ipAddress: ipConfig.ip,
			target: httpProxy.id,
			portRange: '80',
			loadBalancingScheme: 'EXTERNAL_MANAGED',
			ipProtocol: 'TCP'
		}, {
			...optionsOf(ruleName, FORWARDING_RULE_TYPE),
			deleteBeforeReplace: true
		});
	}
}

/**
 * Route rule configuration for URL map
 */
export interface RouteRuleConfig {
	priority: number;
	matchRules: {
		prefixMatch?: string;
		fullPathMatch?: string;
		pathTemplateMatch?: string;
	}[];
	service: pulumi.Input<string>;
	routeAction?: {
		urlRewrite?: {
			pathTemplateRewrite?: string;
		};
	};
}

export interface RouteRuleSpec {
	/** Prefixes served from the static bucket */
	staticPaths: readonly string[];

	/** Exact files served from the static bucket */
	staticFiles: readonly string[];

	/** The API of a full stack app: a prefix sent to its service */
	api?: {
		prefix: string;
		service: pulumi.Input<string>;
	};

	/** The static bucket, which also gets everything else (rewritten to `/`) */
	frontendService: pulumi.Input<string>;
}

/**
 * The one route builder of the front ends: the static prefixes, then the
 * exact files, then the API (when there is one) and last the catch-all. The
 * priorities follow the order. The defaults of each front end are in
 * `ROUTING_DEFAULTS`.
 */
export function buildRouteRules(spec: RouteRuleSpec): RouteRuleConfig[] {
	const rules: RouteRuleConfig[] = [];

	for (const prefixMatch of spec.staticPaths) {
		rules.push({
			priority: rules.length + 1,
			matchRules: [{ prefixMatch }],
			service: spec.frontendService
		});
	}

	for (const fullPathMatch of spec.staticFiles) {
		rules.push({
			priority: rules.length + 1,
			matchRules: [{ fullPathMatch }],
			service: spec.frontendService
		});
	}

	if (spec.api) {
		rules.push({
			priority: rules.length + 1,
			matchRules: [{ prefixMatch: spec.api.prefix }],
			service: spec.api.service
		});
	}

	rules.push({
		priority: rules.length + 1,
		matchRules: [{ pathTemplateMatch: '/**' }],
		service: spec.frontendService,
		routeAction: {
			urlRewrite: {
				pathTemplateRewrite: '/'
			}
		}
	});

	return(rules);
}

/** The certificate of a front end */
export type CertChoice = {
	kind: 'compute';
	id: pulumi.Output<string>;
} | {
	kind: 'certificate-manager';
	id: pulumi.Output<string>;

	/** The host that the certificate map entry matches (otherwise it matches everything) */
	hostname?: pulumi.Input<string>;
} | {
	kind: 'managed';
	domains: pulumi.Input<pulumi.Input<string>[]>;

	/** Makes the name of the certificate, so that a new version replaces it */
	version?: number;
	protect?: boolean;
};

/** The SSL policy of the proxy of a front end */
export type SslPolicyChoice = {
	kind: 'create';
	profile: string;
	minTlsVersion: string;
} | {
	kind: 'existing';
	id: pulumi.Output<string>;
} | {
	kind: 'none';
};

export type IpChoice = { kind: 'ipv4' | 'ipv6' | ''; ip: pulumi.Input<string> };

export interface ParsedFrontEnd {
	domain: pulumi.Input<string>;
	dnsZoneId?: pulumi.Input<string>;
	ipAddress?: IPAddressConfig;
	cert: CertChoice;
	sslPolicy: SslPolicyChoice;
}

/** What the caller wants for the SSL policy: none given (create one), one of theirs, or `false` (none, as in 1.0.95) */
export function parseSslPolicy(sslPolicy: gcp.compute.SSLPolicy | false | undefined): SslPolicyChoice {
	if (sslPolicy === false) {
		return({ kind: 'none' });
	}

	if (sslPolicy === undefined) {
		return({ kind: 'create', ...FRONT_END_DEFAULTS.sslPolicy });
	}

	return({ kind: 'existing', id: pulumi.output(sslPolicy.id) });
}

/**
 * Reads the load balancer configuration of `StaticWebApp` and `FullStackApp`
 * once: the choice of certificate, and the choice of SSL policy.
 */
export function parseFrontEndConfig(config: LoadBalancerConfig): ParsedFrontEnd {
	let cert: CertChoice;
	if ('sslCertificate' in config.ssl && config.ssl.sslCertificate) {
		const certificate = config.ssl.sslCertificate;

		// Discriminate based on presence of certificateId (compute.ManagedSslCertificate only)
		if ('certificateId' in certificate) {
			cert = { kind: 'compute', id: pulumi.output(certificate.id) };
		} else {
			cert = { kind: 'certificate-manager', id: pulumi.output(certificate.id) };
		}
	} else {
		cert = {
			kind: 'managed',
			domains: config.ssl.domains,
			version: config.ssl.sslCertificateVersion,
			protect: config.ssl.protectCert
		};
	}

	return({
		domain: config.domain,
		dnsZoneId: config.dnsZoneId,
		ipAddress: config.ipAddress,
		cert,
		sslPolicy: parseSslPolicy(config.sslPolicy)
	});
}

/**
 * Parse IP address configuration into structured format, creating the
 * global addresses when the caller gave none
 */
export function resolveIpAddresses(
	name: string,
	ipAddress: IPAddressConfig | undefined,
	opts: { parent: pulumi.Resource }
): IpChoice[] {
	const ipAddresses: IpChoice[] = [];

	if (ipAddress === undefined) {
		ipAddresses.push(
			{
				kind: 'ipv4',
				ip: new gcp.compute.GlobalAddress(`${name}-ipv4`, {
					addressType: 'EXTERNAL',
					ipVersion: 'IPV4'
				}, opts).address
			},
			{
				kind: 'ipv6',
				ip: new gcp.compute.GlobalAddress(`${name}-ipv6`, {
					addressType: 'EXTERNAL',
					ipVersion: 'IPV6'
				}, opts).address
			}
		);
	} else if (typeof ipAddress === 'object' && ('ipv4' in ipAddress || 'ipv6' in ipAddress)) {
		if ('ipv4' in ipAddress && ipAddress.ipv4) {
			ipAddresses.push({ kind: 'ipv4', ip: ipAddress.ipv4 });
		}
		if ('ipv6' in ipAddress && ipAddress.ipv6) {
			ipAddresses.push({ kind: 'ipv6', ip: ipAddress.ipv6 });
		}
	} else {
		ipAddresses.push({ kind: '', ip: ipAddress });
	}

	return(ipAddresses);
}

/**
 * What differs between the two callers. The names and the forms of the inputs
 * are the ones each caller has always had, so that nothing is replaced.
 */
export type FrontEndVariant = {
	/** `StaticWebApp` and `FullStackApp`: the resources are children of the app */
	kind: 'app';
} | {
	kind: 'external';

	/** What the certificate, the certificate map, the proxy and the rule are described as: `... for the ${description}` */
	description: string;

	/** The resources that the certificate waits for (the DNS entry of the domain) */
	certDependsOn: pulumi.Resource[];

	/**
	 * The URN of the URL map as it was in 1.0.95. The certificate map, the
	 * proxy, the rule and the redirect were its children and move to the
	 * parent, each with one alias.
	 */
	legacyUrlMap: pulumi.Input<pulumi.URN>;
};

export interface HttpsFrontEnd {
	variant: FrontEndVariant;
	urlMap: gcp.compute.URLMap;
	ips: IpChoice[];

	/** Records `${name}-dns-${kind}` for these ips, for this domain in this zone (`app` only) */
	dns?: {
		zoneId: pulumi.Input<string>;
		domain: pulumi.Input<string>;
	};
}

export interface HttpsFrontEndResources {
	httpsProxy: gcp.compute.TargetHttpsProxy;
	forwardingRules: gcp.compute.GlobalForwardingRule[];

	/** The policy that the front end created for its proxy, if it did */
	sslPolicy?: gcp.compute.SSLPolicy;

	/** The certificate map entry, which the proxy waits for (certificate manager certificates only) */
	certMapEntry?: gcp.certificatemanager.CertificateMapEntry;
}

/**
 * The HTTPS front end of an app or of an `ExternalLoadBalancer`: the
 * certificate (when it is managed), the certificate map and its entry, the SSL
 * policy, the `TargetHttpsProxy`, the forwarding rules, the DNS records and the
 * HTTP redirect. It is a function and not a component, so the URNs of the
 * callers do not move again. Every resource is a child of `opts.parent`.
 */
export function createHttpsFrontEnd(
	name: string,
	parsed: Pick<ParsedFrontEnd, 'cert' | 'sslPolicy'>,
	front: HttpsFrontEnd,
	opts: { parent: pulumi.Resource }
): HttpsFrontEndResources {
	const { variant, urlMap } = front;
	const { cert } = parsed;
	const external = variant.kind === 'external';

	// The old URN of a resource that was a child of the URL map (the external variant only)
	function movedFromUrlMap(resourceName: string, type: string): pulumi.Output<pulumi.URN>[] | undefined {
		if (variant.kind !== 'external') {
			return(undefined);
		}

		return(movedFrom(resourceName, type, { kind: 'resource', urn: variant.legacyUrlMap }));
	}

	// Create or use existing SSL certificate
	let certificateID: pulumi.Output<string>;
	if (cert.kind === 'managed') {
		if (variant.kind === 'external') {
			certificateID = new gcp.compute.ManagedSslCertificate(`${name}-ext-cert`, {
				description: `SSL Certificate for the ${variant.description}`,
				managed: {
					domains: cert.domains
				}
			}, {
				parent: opts.parent,
				dependsOn: variant.certDependsOn
			}).id;
		} else {
			/*
			 * If a sslCertificateVersion is provided, use that as the
			 * name of the resource so that it can be replaced when
			 * the version changes
			 */
			let addToCertName = '';
			if (cert.version !== undefined) {
				addToCertName = `-${cert.version}`;
			}

			certificateID = new gcp.compute.ManagedSslCertificate(`${name}-cert${addToCertName}`, {
				managed: {
					domains: cert.domains
				}
			}, {
				parent: opts.parent,
				protect: cert.protect
			}).id;
		}
	} else {
		certificateID = cert.id;
	}

	// The SSL policy of the proxy: made here, the caller's, or none
	let sslPolicy: gcp.compute.SSLPolicy | undefined;
	let sslPolicyID: pulumi.Output<string> | undefined;
	if (parsed.sslPolicy.kind === 'create') {
		sslPolicy = new gcp.compute.SSLPolicy(`${name}-ssl-policy`, {
			profile: parsed.sslPolicy.profile,
			minTlsVersion: parsed.sslPolicy.minTlsVersion
		}, {
			parent: opts.parent
		});
		sslPolicyID = sslPolicy.id;
	} else if (parsed.sslPolicy.kind === 'existing') {
		sslPolicyID = parsed.sslPolicy.id;
	}

	let policyArgs: { sslPolicy?: pulumi.Output<string> } = {};
	if (sslPolicyID !== undefined) {
		policyArgs = { sslPolicy: sslPolicyID };
	}

	// Create HTTPS proxy
	let certMapEntry: gcp.certificatemanager.CertificateMapEntry | undefined;
	let proxyCertArgs: { certificateMap: pulumi.Output<string> } | { sslCertificates: pulumi.Output<string>[] };
	if (cert.kind === 'certificate-manager') {
		const certMapName = external ? `${name}-ext-cert-map` : `${name}-cert-map`;
		let certMapDescription = `[${name}] Certificate map for load balancer`;
		if (variant.kind === 'external') {
			certMapDescription = `Certificate map for the ${variant.description}`;
		}

		const certMap = new gcp.certificatemanager.CertificateMap(certMapName, {
			description: certMapDescription
		}, {
			parent: opts.parent,
			aliases: movedFromUrlMap(certMapName, CERTIFICATE_MAP_TYPE)
		});

		/*
		 * The proxy must wait for the entry, to ensure the certificate is
		 * properly associated before the proxy is created, or it will fail.
		 * An app has one map for each load balancer, so its entry matches
		 * everything (PRIMARY); an external load balancer matches the host
		 * of its domain when it has one.
		 */
		const entryName = `${name}${external ? '-ext' : ''}-cert-map-entry`;
		let entryHostArgs: { hostname?: pulumi.Input<string>; matcher?: string } = { matcher: 'PRIMARY' };
		if (variant.kind === 'external' && cert.hostname !== undefined) {
			entryHostArgs = { hostname: cert.hostname };
		}

		let entryAliases: pulumi.Output<pulumi.URN>[] | undefined;
		if (variant.kind === 'external') {
			entryAliases = movedFrom(entryName, CERTIFICATE_MAP_ENTRY_TYPE, {
				kind: 'resource',
				urn: legacyUrn(certMapName, CERTIFICATE_MAP_TYPE, { kind: 'resource', urn: variant.legacyUrlMap })
			});
		}

		certMapEntry = new gcp.certificatemanager.CertificateMapEntry(entryName, {
			map: certMap.name,
			certificates: [certificateID],
			...entryHostArgs
		}, {
			parent: opts.parent,
			aliases: entryAliases
		});

		proxyCertArgs = {
			certificateMap: pulumi.interpolate`//certificatemanager.googleapis.com/${certMap.id}`
		};
	} else {
		proxyCertArgs = {
			sslCertificates: [certificateID]
		};
	}

	let httpsProxy: gcp.compute.TargetHttpsProxy;
	const dependsOn: pulumi.Resource[] = [];
	if (certMapEntry) {
		dependsOn.push(certMapEntry);
	}

	if (variant.kind === 'external') {
		const proxyName = `${name}-ext-target`;
		httpsProxy = new gcp.compute.TargetHttpsProxy(proxyName, {
			description: `Target HTTPS Proxy for the ${variant.description}`,
			urlMap: urlMap.name,
			...proxyCertArgs,
			...policyArgs
		}, {
			parent: opts.parent,
			dependsOn,
			aliases: movedFromUrlMap(proxyName, HTTPS_PROXY_TYPE)
		});
	} else {
		httpsProxy = new gcp.compute.TargetHttpsProxy(`${name}-https-proxy`, {
			urlMap: urlMap.id,
			...proxyCertArgs,
			...policyArgs
		}, {
			parent: opts.parent,
			dependsOn,
			/*
			 * It seems like we need to replace the proxy when the kind
			 * of certificate changes, or GCP gets confused
			 */
			replaceOnChanges: ['certificateMap', 'sslCertificates']
		});
	}

	// Create forwarding rules and DNS records
	const forwardingRules: gcp.compute.GlobalForwardingRule[] = [];
	for (const ipConfig of front.ips) {
		if (variant.kind === 'external') {
			const ruleName = `${name}-lb`;
			forwardingRules.push(new gcp.compute.GlobalForwardingRule(ruleName, {
				description: `External Load Balancer for the ${variant.description}`,
				target: httpsProxy.id,
				loadBalancingScheme: 'EXTERNAL_MANAGED',
				ipAddress: ipConfig.ip,
				portRange: '443'
			}, {
				parent: opts.parent,
				aliases: movedFromUrlMap(ruleName, FORWARDING_RULE_TYPE)
			}));

			continue;
		}

		const ruleName = `${name}-fr-${ipConfig.kind}`.replace(/-$/, '');
		forwardingRules.push(new gcp.compute.GlobalForwardingRule(ruleName, {
			ipAddress: ipConfig.ip,
			target: httpsProxy.id,
			portRange: '443',
			loadBalancingScheme: 'EXTERNAL_MANAGED',
			ipProtocol: 'TCP'
		}, {
			parent: opts.parent,
			deleteBeforeReplace: true
		}));

		// Create DNS records if zone ID provided
		if (front.dns && ipConfig.kind !== '') {
			new gcp.dns.RecordSet(`${name}-dns-${ipConfig.kind}`, {
				name: pulumi.output(front.dns.domain).apply(function(d) { return(d.endsWith('.') ? d : `${d}.`); }),
				type: ipConfig.kind === 'ipv4' ? 'A' : 'AAAA',
				ttl: 300,
				managedZone: front.dns.zoneId,
				rrdatas: [ipConfig.ip]
			}, {
				parent: opts.parent
			});
		}
	}

	if (variant.kind === 'external') {
		createHttpRedirect(name, front.ips, { parent: opts.parent, oldParent: variant.legacyUrlMap });
	} else {
		createHttpRedirect(name, front.ips, { parent: opts.parent, oldParent: urlMap.urn });
	}

	return({
		httpsProxy,
		forwardingRules,
		sslPolicy,
		certMapEntry
	});
}
