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

export type IPChoice = { kind: 'ipv4' | 'ipv6' | ''; ip: pulumi.Input<string> };

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
export function resolveIPAddresses(
	name: string,
	ipAddress: IPAddressConfig | undefined,
	opts: { parent: pulumi.Resource }
): IPChoice[] {
	const ipAddresses: IPChoice[] = [];

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

export interface HTTPSFrontEnd {
	variant: FrontEndVariant;
	urlMap: gcp.compute.URLMap;
	ips: IPChoice[];

	/** Records `${name}-dns-${kind}` for these ips, for this domain in this zone (`app` only) */
	dns?: {
		zoneId: pulumi.Input<string>;
		domain: pulumi.Input<string>;
	};
}

export interface HTTPSFrontEndResources {
	httpsProxy: gcp.compute.TargetHttpsProxy;
	forwardingRules: gcp.compute.GlobalForwardingRule[];
}

type ManagedCert = Extract<ParsedFrontEnd['cert'], { kind: 'managed' }>;
type CertificateManagerCert = Extract<ParsedFrontEnd['cert'], { kind: 'certificate-manager' }>;
type Aliases = pulumi.Output<pulumi.URN>[] | undefined;

/**
 * The names, descriptions and forms of the inputs of one variant, worked out
 * once. The front end itself has one path and reads them from here, so the
 * two callers are not two front ends interleaved.
 */
interface VariantShape {
	managedCertificate(cert: ManagedCert, parent: pulumi.Resource): pulumi.Output<string>;
	certMap: { name: string; description: string; aliases: Aliases };
	entry: { name: string; aliases: Aliases; host(cert: CertificateManagerCert): { hostname?: pulumi.Input<string>; matcher?: string }};
	proxy: {
		name: string;
		description?: string;
		urlMap: pulumi.Input<string>;
		options: Pick<pulumi.CustomResourceOptions, 'aliases' | 'replaceOnChanges'>;
	};
	rule(ipConfig: IPChoice, target: pulumi.Input<string>): {
		name: string;
		args: gcp.compute.GlobalForwardingRuleArgs;
		options: Pick<pulumi.CustomResourceOptions, 'aliases' | 'deleteBeforeReplace'>;
	};

	/** Whether the front end creates the DNS records of its domain */
	dns: boolean;

	/** The URN that the redirect resources answer to */
	redirectOldParent: pulumi.Input<pulumi.URN>;
}

function appShape(name: string, urlMap: gcp.compute.URLMap): VariantShape {
	return({
		managedCertificate: function(cert, parent) {
			/*
			 * If a sslCertificateVersion is provided, use that as the
			 * name of the resource so that it can be replaced when
			 * the version changes
			 */
			let addToCertName = '';
			if (cert.version !== undefined) {
				addToCertName = `-${cert.version}`;
			}

			return(new gcp.compute.ManagedSslCertificate(`${name}-cert${addToCertName}`, {
				managed: { domains: cert.domains }
			}, { parent, protect: cert.protect }).id);
		},
		certMap: { name: `${name}-cert-map`, description: `[${name}] Certificate map for load balancer`, aliases: undefined },
		// An app has one map for each load balancer, so its entry matches everything
		entry: { name: `${name}-cert-map-entry`, aliases: undefined, host: function() {
			return({ matcher: 'PRIMARY' });
		} },
		proxy: {
			name: `${name}-https-proxy`,
			urlMap: urlMap.id,

			/* It seems like we need to replace the proxy when the kind of certificate changes, or GCP gets confused */
			options: { replaceOnChanges: [ 'certificateMap', 'sslCertificates' ] }
		},
		rule: function(ipConfig, target) {
			return({
				name: `${name}-fr-${ipConfig.kind}`.replace(/-$/, ''),
				args: { ipAddress: ipConfig.ip, target, portRange: '443', loadBalancingScheme: 'EXTERNAL_MANAGED', ipProtocol: 'TCP' },
				options: { deleteBeforeReplace: true }
			});
		},
		dns: true,
		redirectOldParent: urlMap.urn
	});
}

function externalShape(name: string, urlMap: gcp.compute.URLMap, variant: Extract<FrontEndVariant, { kind: 'external' }>): VariantShape {
	/** The old URN of a resource that was a child of the URL map */
	function movedFromUrlMap(resourceName: string, type: string): Aliases {
		return(movedFrom(resourceName, type, { kind: 'resource', urn: variant.legacyUrlMap }));
	}

	const certMapName = `${name}-ext-cert-map`;
	const entryName = `${name}-ext-cert-map-entry`;
	const proxyName = `${name}-ext-target`;

	return({
		managedCertificate: function(cert, parent) {
			return(new gcp.compute.ManagedSslCertificate(`${name}-ext-cert`, {
				description: `SSL Certificate for the ${variant.description}`,
				managed: { domains: cert.domains }
			}, { parent, dependsOn: variant.certDependsOn }).id);
		},
		certMap: { name: certMapName, description: `Certificate map for the ${variant.description}`, aliases: movedFromUrlMap(certMapName, CERTIFICATE_MAP_TYPE) },
		// The entry was a child of the certificate map, which was a child of the URL map: both levels moved
		entry: {
			name: entryName,
			aliases: movedFrom(entryName, CERTIFICATE_MAP_ENTRY_TYPE, {
				kind: 'resource',
				urn: legacyUrn(certMapName, CERTIFICATE_MAP_TYPE, { kind: 'resource', urn: variant.legacyUrlMap })
			}),
			// It matches the host of its domain when it has one
			host: function(cert) {
				if (cert.hostname === undefined) {
					return({ matcher: 'PRIMARY' });
				}

				return({ hostname: cert.hostname });
			}
		},
		proxy: {
			name: proxyName,
			description: `Target HTTPS Proxy for the ${variant.description}`,
			urlMap: urlMap.name,
			options: { aliases: movedFromUrlMap(proxyName, HTTPS_PROXY_TYPE) }
		},
		rule: function(ipConfig, target) {
			const ruleName = `${name}-lb`;

			return({
				name: ruleName,
				args: {
					description: `External Load Balancer for the ${variant.description}`,
					target,
					loadBalancingScheme: 'EXTERNAL_MANAGED',
					ipAddress: ipConfig.ip,
					portRange: '443'
				},
				options: { aliases: movedFromUrlMap(ruleName, FORWARDING_RULE_TYPE) }
			});
		},
		dns: false,
		redirectOldParent: variant.legacyUrlMap
	});
}

function shapeOf(name: string, front: HTTPSFrontEnd): VariantShape {
	if (front.variant.kind === 'external') {
		return(externalShape(name, front.urlMap, front.variant));
	}

	return(appShape(name, front.urlMap));
}

/** The SSL policy of the proxy: made here, the caller's, or none */
function resolveSslPolicy(name: string, choice: SslPolicyChoice, parent: pulumi.Resource) {
	if (choice.kind === 'create') {
		const policy = new gcp.compute.SSLPolicy(`${name}-ssl-policy`, {
			profile: choice.profile,
			minTlsVersion: choice.minTlsVersion
		}, { parent });

		return(policy.id);
	}

	if (choice.kind === 'existing') {
		return(choice.id);
	}

	return(undefined);
}

/** The certificate map and its entry (certificate manager certificates only) */
function createCertificateMap(shape: VariantShape, cert: CertificateManagerCert, certificateID: pulumi.Output<string>, parent: pulumi.Resource) {
	const certMap = new gcp.certificatemanager.CertificateMap(shape.certMap.name, {
		description: shape.certMap.description
	}, { parent, aliases: shape.certMap.aliases });

	const entry = new gcp.certificatemanager.CertificateMapEntry(shape.entry.name, {
		map: certMap.name,
		certificates: [certificateID],
		...shape.entry.host(cert)
	}, { parent, aliases: shape.entry.aliases });

	return({ entry, mapId: pulumi.interpolate`//certificatemanager.googleapis.com/${certMap.id}` });
}

/** The DNS records of a domain in a zone, one for the kind of address */
function createDnsRecord(name: string, ipConfig: IPChoice, dns: NonNullable<HTTPSFrontEnd['dns']>, parent: pulumi.Resource) {
	let recordType = 'AAAA';
	if (ipConfig.kind === 'ipv4') {
		recordType = 'A';
	}

	new gcp.dns.RecordSet(`${name}-dns-${ipConfig.kind}`, {
		name: pulumi.output(dns.domain).apply(function(domain) {
			if (domain.endsWith('.')) {
				return(domain);
			}

			return(`${domain}.`);
		}),
		type: recordType,
		ttl: 300,
		managedZone: dns.zoneId,
		rrdatas: [ipConfig.ip]
	}, { parent });
}

/**
 * The HTTPS front end of an app or of an `ExternalLoadBalancer`: the
 * certificate (when it is managed), the certificate map and its entry, the SSL
 * policy, the `TargetHttpsProxy`, the forwarding rules, the DNS records and the
 * HTTP redirect. It is a function and not a component, so the URNs of the
 * callers do not move again. Every resource is a child of `opts.parent`.
 */
export function createHTTPSFrontEnd(
	name: string,
	parsed: Pick<ParsedFrontEnd, 'cert' | 'sslPolicy'>,
	front: HTTPSFrontEnd,
	opts: { parent: pulumi.Resource }
): HTTPSFrontEndResources {
	const { cert } = parsed;
	const { parent } = opts;
	const shape = shapeOf(name, front);

	// Create or use existing SSL certificate
	let certificateID: pulumi.Output<string>;
	if (cert.kind === 'managed') {
		certificateID = shape.managedCertificate(cert, parent);
	} else {
		certificateID = cert.id;
	}

	const sslPolicyID = resolveSslPolicy(name, parsed.sslPolicy, parent);
	let policyArgs: { sslPolicy?: pulumi.Output<string> } = {};
	if (sslPolicyID !== undefined) {
		policyArgs = { sslPolicy: sslPolicyID };
	}

	// The proxy must wait for the entry, so that the certificate is associated before the proxy is created, or it fails
	let proxyCertArgs: { certificateMap: pulumi.Output<string> } | { sslCertificates: pulumi.Output<string>[] } = { sslCertificates: [certificateID] };
	const dependsOn: pulumi.Resource[] = [];
	if (cert.kind === 'certificate-manager') {
		const map = createCertificateMap(shape, cert, certificateID, parent);
		proxyCertArgs = { certificateMap: map.mapId };
		dependsOn.push(map.entry);
	}

	const httpsProxy = new gcp.compute.TargetHttpsProxy(shape.proxy.name, {
		description: shape.proxy.description,
		urlMap: shape.proxy.urlMap,
		...proxyCertArgs,
		...policyArgs
	}, { parent, dependsOn, ...shape.proxy.options });

	// Create forwarding rules and DNS records
	const forwardingRules: gcp.compute.GlobalForwardingRule[] = [];
	for (const ipConfig of front.ips) {
		const rule = shape.rule(ipConfig, httpsProxy.id);
		forwardingRules.push(new gcp.compute.GlobalForwardingRule(rule.name, rule.args, { parent, ...rule.options }));

		if (shape.dns && front.dns && ipConfig.kind !== '') {
			createDnsRecord(name, ipConfig, front.dns, parent);
		}
	}

	createHttpRedirect(name, front.ips, { parent, oldParent: shape.redirectOldParent });

	return({ httpsProxy, forwardingRules });
}
