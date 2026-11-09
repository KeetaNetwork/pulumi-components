import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { extractServiceURL } from './common';
import type { GCPCommonOptions, CertificateManagerCert, ComputeManagedSslCert } from './common';
import type { GCPRegion } from './constants';
import type { EnvironmentVariables } from './cloudrun';
import { GoogleCloudFolderWithArgs } from './bucket';
import { EnvManager, EnvView } from './cloudrun';
import type { ReplacedEnvironment } from './cloudrun';
import { PostgresCloudSQL } from './sql';
import type { ContainerGeneric } from './container';
import { ContainerMIG, ContainerCloudRun } from './container';
import { MigrationJob } from './migration';
import { AppNetwork } from './network';
import { ServiceIdentity } from './identity';
import { parseCloudRunServiceArgs } from './apps-args';
import type { MigWorkerArgs, CrwpWorkerArgs, LegacyMigArgs, ParsedCloudRunServiceArgs, ParsedRemote } from './apps-args';
export { CloudRunServiceArgsError } from './apps-args';
export type { MigWorkerArgs, CrwpWorkerArgs, LegacyMigArgs } from './apps-args';
import { CLOUD_RUN_SERVICE_DEFAULTS } from './defaults';
import { callerOf } from './client-auth';
import { buildDatabaseEnvVars, buildRedisEnvVars } from './database-env';
import { createHttpRedirect } from './lb';
import { legacyUrn, movedFrom } from './aliases';
import * as components from '../docker';
import { generateName } from '../../utils';

export interface IPv4AddressConfig {
	ipv4: pulumi.Input<string>;
	ipv6?: pulumi.Input<string>;
}

export interface IPv6AddressConfig {
	ipv4?: pulumi.Input<string>;
	ipv6: pulumi.Input<string>;
}

export type IPAddressConfig = pulumi.Input<string> | IPv4AddressConfig | IPv6AddressConfig;

interface SSLCertificateConfig {
	sslCertificate: CertificateManagerCert | ComputeManagedSslCert;
	domains?: never;
	protectCert?: never;
}

interface DomainsConfig {
	domains: pulumi.Input<string[]>;
	protectCert?: boolean;
	sslCertificateVersion?: number;
	sslCertificate?: never;
}

export type SSLConfig = SSLCertificateConfig | DomainsConfig;

/**
 * Load balancer configuration that can be shared between components
 */
export interface LoadBalancerConfig {
	/**
	 * Domain configuration
	 */
	domain: pulumi.Input<string>;

	/**
	 * DNS zone for creating DNS records (optional)
	 */
	dnsZoneId?: pulumi.Input<string>;

	/**
	 * IP address configuration
	 */
	ipAddress?: IPAddressConfig;

	/**
	 * SSL certificate configuration
	 */
	ssl: SSLConfig;
}

/**
 * Result of creating a load balancer
 */
interface LoadBalancerResources {
	urlMap: gcp.compute.URLMap;
	httpsProxy: gcp.compute.TargetHttpsProxy;
	forwardingRules: gcp.compute.GlobalForwardingRule[];
	ips: pulumi.Output<string[]>;
}

/**
 * Route rule configuration for URL map
 */
interface RouteRuleConfig {
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

/**
 * Parse IP address configuration into structured format
 */
function parseIPAddresses(
	name: string,
	ipAddress: IPAddressConfig | undefined,
	opts: { parent: pulumi.Resource }
): { kind: 'ipv4' | 'ipv6' | ''; ip: pulumi.Input<string> }[] {
	const ipAddresses: { kind: 'ipv4' | 'ipv6' | ''; ip: pulumi.Input<string> }[] = [];

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
 * Create a load balancer with URL map, HTTPS proxy, and forwarding rules
 */
function createLoadBalancer(
	name: string,
	config: LoadBalancerConfig,
	routeRules: RouteRuleConfig[],
	defaultService: pulumi.Input<string>,
	opts: { parent: pulumi.Resource }
): LoadBalancerResources {
	// Create URL map with routing rules
	const urlMap = new gcp.compute.URLMap(`${name}-url-map`, {
		defaultService,
		pathMatchers: [{
			name: 'all',
			defaultService,
			routeRules
		}],
		hostRules: [{
			hosts: ['*'],
			pathMatcher: 'all'
		}]
	}, opts);

	// Create or use existing SSL certificate
	let certificateID: pulumi.Output<string>;
	let useCertificateManager: boolean;
	if ('sslCertificate' in config.ssl && config.ssl.sslCertificate) {
		const cert = config.ssl.sslCertificate;
		certificateID = pulumi.output(cert.id);

		// Discriminate based on presence of certificateId (compute.ManagedSslCertificate only)
		if ('certificateId' in cert) {
			// This is a compute.ManagedSslCertificate
			useCertificateManager = false;
		} else {
			// This is a certificatemanager.Certificate
			useCertificateManager = true;
		}
	} else {
		/*
		 * If a sslCertificateVersion is provided, use that as the
		 * name of the resource so that it can be replaced when
		 * the version changes
		 */
		let addToCertName = '';
		if ('sslCertificateVersion' in config.ssl && config.ssl.sslCertificateVersion !== undefined) {
			addToCertName = `-${config.ssl.sslCertificateVersion}`;
		}

		// Create a new compute.ManagedSslCertificate
		const sslCertificate = new gcp.compute.ManagedSslCertificate(`${name}-cert${addToCertName}`, {
			managed: {
				domains: config.ssl.domains
			}
		}, {
			...opts,
			protect: config.ssl.protectCert
		});
		certificateID = sslCertificate.id;
		useCertificateManager = false;
	}

	// Create HTTPS proxy
	const toDependOn: pulumi.Resource[] = [];
	let proxyConfig: ConstructorParameters<typeof gcp.compute.TargetHttpsProxy>[1];
	if (useCertificateManager) {
		const certMap = new gcp.certificatemanager.CertificateMap(`${name}-cert-map`, {
			description: `[${name}] Certificate map for load balancer`
		}, opts);

		/*
		 * We need to make the TargetHttpsProxy depend on the
		 * CertificateMapEntry to ensure the certificate is properly
		 * associated before the proxy is created, or it will fail
		 */
		const certMapEntry = new gcp.certificatemanager.CertificateMapEntry(`${name}-cert-map-entry`, {
			map: certMap.name,
			certificates: [certificateID],
			/*
			 * Since we create one cert-map per Load Balancer we
			 * can just use the "PRIMARY" matcher to match all
			 * requests, and avoid having to specify which domains
			 * to match in the entry.
			 */
			matcher: 'PRIMARY'
		}, opts);
		toDependOn.push(certMapEntry);

		proxyConfig = {
			urlMap: urlMap.id,
			certificateMap: pulumi.interpolate`//certificatemanager.googleapis.com/${certMap.id}`
		};
	} else {
		proxyConfig = {
			urlMap: urlMap.id,
			sslCertificates: [certificateID]
		};
	}
	const httpsProxy = new gcp.compute.TargetHttpsProxy(`${name}-https-proxy`, proxyConfig, {
		...opts,
		dependsOn: toDependOn.splice(0),
		/*
		 * It seems like we need to replace the proxy when the kind
		 * of certificate changes, or GCP gets confused
		 */
		replaceOnChanges: ['certificateMap', 'sslCertificates']
	});

	// Parse IP addresses
	const ipAddresses = parseIPAddresses(name, config.ipAddress, opts);
	const forwardingRules: gcp.compute.GlobalForwardingRule[] = [];

	// Create forwarding rules and DNS records
	for (const ipConfig of ipAddresses) {
		const ruleName = `${name}-fr-${ipConfig.kind}`.replace(/-$/, '');
		const rule = new gcp.compute.GlobalForwardingRule(ruleName, {
			ipAddress: ipConfig.ip,
			target: httpsProxy.id,
			portRange: '443',
			loadBalancingScheme: 'EXTERNAL_MANAGED',
			ipProtocol: 'TCP'
		}, {
			...opts,
			deleteBeforeReplace: true
		});
		forwardingRules.push(rule);

		// Create DNS records if zone ID provided
		if (config.dnsZoneId && ipConfig.kind !== '') {
			new gcp.dns.RecordSet(`${name}-dns-${ipConfig.kind}`, {
				name: pulumi.output(config.domain).apply(function(d) { return(d.endsWith('.') ? d : `${d}.`); }),
				type: ipConfig.kind === 'ipv4' ? 'A' : 'AAAA',
				ttl: 300,
				managedZone: config.dnsZoneId,
				rrdatas: [ipConfig.ip]
			}, opts);
		}
	}

	createHttpRedirect(name, ipAddresses, { parent: opts.parent, oldParent: urlMap.urn });

	const ips = pulumi.all(forwardingRules.map(function(fr) { return(fr.ipAddress); })).apply(function(ips) {
		return(ips.filter(function(ip): ip is string { return(ip !== undefined && ip !== null); }));
	});

	return({
		urlMap,
		httpsProxy,
		forwardingRules,
		ips
	});
}

/**
 * Configuration for a Static Web Application (SPA)
 * Deploys static files to GCS bucket with a backend bucket (for use in load balancer)
 */
export interface StaticWebAppArgs {
	/**
	 * Path to the directory containing static files
	 */
	staticFilesPath: string;

	/**
	 * Optional bucket configuration
	 */
	bucketConfig?: Partial<gcp.storage.BucketArgs>;

	/**
	 * Optional filter for files to upload
	 */
	fileFilter?: ConstructorParameters<typeof GoogleCloudFolderWithArgs>[1]['filter'];

	/**
	 * Optional function to compute content type for uploaded files
	 */
	computeContentType?: ConstructorParameters<typeof GoogleCloudFolderWithArgs>[1]['computeContentType'];

	/**
	 * Custom headers to serve in replies, default is just 'X-Frame-Options: DENY'
	 */
	customResponseHeaders?: ConstructorParameters<typeof gcp.compute.BackendBucket>[1]['customResponseHeaders'];

	/**
	 * Cache control options for uploaded files
	 */
	cacheControl?: {
		/**
		 * Cache duration for index.html (default: 10 seconds)
		 */
		indexTTL?: number;

		/**
		 * Cache duration for hashed assets (default: 1 day)
		 */
		assetsTTL?: number;

		/**
		 * Path prefix used to identify hashed asset files (default: 'assets/')
		 */
		assetsPrefix?: string;

		/**
		 * Cache duration for other files (default: 5 minutes)
		 */
		defaultTTL?: number;
	};

	/**
	 * Cloud CDN options for the backend bucket (default: disabled)
	 */
	cdn?: { enabled: false } | {
		enabled: true;

		/**
		 * Dynamic gzip or Brotli compression, from the client Accept-Encoding (default: 'AUTOMATIC')
		 */
		compressionMode?: pulumi.Input<'AUTOMATIC' | 'DISABLED'>;

		/**
		 * Cache policy (default: cache mode 'USE_ORIGIN_HEADERS', which follows the cacheControl TTLs)
		 */
		cdnPolicy?: pulumi.Input<gcp.types.input.compute.BackendBucketCdnPolicy & {
			cacheMode: pulumi.Input<'CACHE_ALL_STATIC' | 'USE_ORIGIN_HEADERS' | 'FORCE_CACHE_ALL'>;
		}>;
	};

	/**
	 * Optional load balancer configuration
	 * If provided, creates a complete HTTPS load balancer for standalone SPA deployment
	 * If not provided, only creates backend bucket for use in composed deployments
	 */
	loadBalancer?: LoadBalancerConfig;

	/**
	 * Routing configuration for static paths when using standalone load balancer
	 */
	routing?: {
		/**
		 * Static paths to serve (e.g., ['/assets/', '/icons/'])
		 */
		staticPaths?: string[];

		/**
		 * Static files to serve (e.g., ['/favicon.svg'])
		 */
		staticFiles?: string[];
	};
}

/**
 * Static Web Application Component
 * Deploys a SPA to GCS bucket with backend bucket ready for load balancer
 * Optionally creates a full HTTPS load balancer if loadBalancer config is provided
 */
export class StaticWebApp extends pulumi.ComponentResource {
	readonly bucket: gcp.storage.Bucket;
	readonly backendBucket: gcp.compute.BackendBucket;
	readonly urlMap?: gcp.compute.URLMap;
	readonly httpsProxy?: gcp.compute.TargetHttpsProxy;
	readonly forwardingRules?: gcp.compute.GlobalForwardingRule[];
	readonly ips?: pulumi.Output<string[]>;

	constructor(name: string, args: StaticWebAppArgs, opts?: pulumi.ComponentResourceOptions) {
		super('Keeta:GCP:StaticWebApp', name, args, opts);

		const bucket = new gcp.storage.Bucket(`${name}-bucket`, {
			location: 'US',
			forceDestroy: true,
			softDeletePolicy: {
				retentionDurationSeconds: 0
			},
			website: {
				mainPageSuffix: 'index.html',
				notFoundPage: 'index.html'
			},
			uniformBucketLevelAccess: true,
			...args.bucketConfig
		}, {
			parent: this,
			aliases: movedFrom(`${name}-bucket`, 'gcp:storage/bucket:Bucket', { kind: 'stack' })
		});

		new gcp.storage.BucketIAMMember(`${name}-bucket-viewer`, {
			bucket: bucket.name,
			role: 'roles/storage.objectViewer',
			member: 'allUsers'
		}, {
			parent: this,
			aliases: movedFrom(`${name}-bucket-viewer`, 'gcp:storage/bucketIAMMember:BucketIAMMember', { kind: 'stack' }),
			deletedWith: bucket
		});

		const cacheControl = args.cacheControl ?? {};
		const indexTTL = cacheControl.indexTTL ?? 10;
		const assetsTTL = cacheControl.assetsTTL ?? 86400;
		const assetsPrefix = cacheControl.assetsPrefix ?? 'assets/';
		const defaultTTL = cacheControl.defaultTTL ?? 300;

		void new GoogleCloudFolderWithArgs(`${name}-files`, {
			bucketName: bucket.name,
			path: args.staticFilesPath,
			filter: args.fileFilter,
			computeContentType: args.computeContentType,
			options: {
				generated: function(fileName: string) {
					let ttl: number;
					let retainOnDelete = false;
					if (fileName === 'index.html') {
						ttl = indexTTL;
					} else if (fileName.startsWith(assetsPrefix)) {
						ttl = assetsTTL;

						/**
						 * Assets are assumed to be
						 * content-hashed and
						 * immutable, so we can retain
						 * them on delete so that users
						 * with the old application
						 * version don't lose access to
						 * them.
						 */
						retainOnDelete = true;
					} else {
						ttl = defaultTTL;
					}
					return({
						cacheControl: `public, max-age=${ttl}`,
						retainOnDelete: retainOnDelete
					});
				}
			}
		}, {
			parent: this,
			aliases: movedFrom(`${name}-files`, 'keeta:synced-folder:GoogleCloudFolderWithArgs', { kind: 'stack' })
		});

		const customResponseHeadersInput = args.customResponseHeaders ?? [];
		const customResponseHeaders = pulumi.output(customResponseHeadersInput).apply(function(headers) {
			headers ??= [];

			/*
			 * Merge the headers using the Headers class
			 */
			const headersObject = new Headers();
			headersObject.set('X-Frame-Options', 'DENY');
			for (const header of headers) {
				const key = header.split(':')[0].trim();
				const value = header.split(':').slice(1).join(':').trim();

				headersObject.set(key, value);
			}

			/*
			 * Convert back to array format
			 */
			const retval: string[] = [];
			headersObject.forEach(function(value, key) {
				retval.push(`${key}: ${value}`);
			});

			return(retval);
		});

		const cdn = args.cdn;
		const cdnEnabled = cdn?.enabled === true;
		const backendBucket = new gcp.compute.BackendBucket(`${name}-backend`, {
			bucketName: bucket.name,
			customResponseHeaders: customResponseHeaders,
			enableCdn: cdnEnabled,
			...(cdnEnabled ? {
				compressionMode: cdn.compressionMode ?? 'AUTOMATIC',
				cdnPolicy: cdn.cdnPolicy ?? { cacheMode: 'USE_ORIGIN_HEADERS' }
			} : {})
		}, {
			parent: this,
			aliases: movedFrom(`${name}-backend`, 'gcp:compute/backendBucket:BackendBucket', { kind: 'stack' })
		});

		this.bucket = bucket;
		this.backendBucket = backendBucket;

		if (args.loadBalancer) {
			const lb = args.loadBalancer;
			const routing = args.routing ?? {};
			const staticPaths = routing.staticPaths ?? ['/assets/', '/icons/', '/fonts/', '/images/'];
			const staticFiles = routing.staticFiles ?? [];

			const routeRules: RouteRuleConfig[] = [
				...staticPaths.map(function(path, priority): RouteRuleConfig {
					return({
						priority: priority + 1,
						matchRules: [{ prefixMatch: path }],
						service: backendBucket.id
					});
				}),
				...staticFiles.map(function(file, priority): RouteRuleConfig {
					return({
						priority: staticPaths.length + priority + 1,
						matchRules: [{ fullPathMatch: file }],
						service: backendBucket.id
					});
				}),
				{
					priority: staticPaths.length + staticFiles.length + 1,
					matchRules: [{ pathTemplateMatch: '/**' }],
					service: backendBucket.id,
					routeAction: {
						urlRewrite: {
							pathTemplateRewrite: '/'
						}
					}
				}
			];

			const lbResources = createLoadBalancer(
				name,
				lb,
				routeRules,
				backendBucket.id,
				{ parent: this }
			);

			this.urlMap = lbResources.urlMap;
			this.httpsProxy = lbResources.httpsProxy;
			this.forwardingRules = lbResources.forwardingRules;
			this.ips = lbResources.ips;
		}

		const outputs: { [key: string]: unknown } = {
			bucket: bucket.name,
			backendBucket: backendBucket.id
		};

		if (this.ips) {
			outputs.ips = this.ips;
		}

		this.registerOutputs(outputs);
	}
}

/**
 * Configuration for Cloud Run backend service
 */
export interface CloudRunServiceArgs {
	/**
	 * GCP project and common options
	 */
	gcp: GCPCommonOptions;

	/**
	 * Region to deploy to
	 */
	region: GCPRegion;

	/**
	 * Docker image configuration: either the URI of an image or a
	 * configuration to build one (not both)
	 */
	image: {
		/**
		 * Docker image URI
		 */
		uri: pulumi.Input<string>;
		build?: never;
	} | {
		uri?: never;

		/**
		 * Build configuration (alternative to uri)
		 */
		build: {
			directory: string;
			registryUrl?: pulumi.Input<string>;
			imageName: string;
			target?: string;
			platform?: string;
			buildArgs?: { [key: string]: pulumi.Input<string> };
			secrets?: { [key: string]: pulumi.Input<string> };
			githubSha?: string;
			nodeImage?: pulumi.Input<string>;

			/**
			 * Remote build configuration (Cloud Build)
			 * If provided, the image is built using GCP Cloud Build instead of local Docker
			 */
			remote?: {
				serviceAccount?: Pick<gcp.serviceaccount.Account, 'email'>;
				bucket?: Pick<gcp.storage.Bucket, 'name'> | gcp.storage.Bucket;
				bucketConfig?: Partial<Pick<gcp.storage.BucketArgs, 'logging'>>;
				bindPermissions?: boolean;
				machineType?: string;

				/**
				 * Time that Cloud Build gives the build, in seconds
				 * @default BUILD_DEFAULTS.timeoutSeconds
				 */
				timeoutSeconds?: number;
			};
		};
	};

	/**
	 * Environment variables for the Cloud Run service
	 */
	environment?: EnvironmentVariables;

	/**
	 * Database configuration (optional)
	 */
	database?: {
		/**
		 * Database engine type. Currently only 'postgres' is supported.
		 */
		type?: 'postgres';

		/**
		 * Tier for the database instance
		 */
		tier?: string;

		/**
		 * Database engine version
		 * @default POSTGRES_DEFAULTS.version
		 */
		version?: string;

		/**
		 * Length of the query strings that query insights records
		 * @default POSTGRES_DEFAULTS.queryStringLength
		 */
		queryStringLength?: number;

		/**
		 * Whether to enable deletion protection (default: false)
		 */
		deletionProtection?: boolean;

		/**
		 * Additional database flags
		 */
		flags?: { [key: string]: number };

		/**
		 * Whether query insights should be enabled
		 */
		queryInsights?: boolean;

		/**
		 * Replication configuration for created database
		 */
		replication?: {
			/**
			 * Whether or not to enable replication across multiple zones of the same region
			 */
			multiZone?: boolean;

			/**
			 * Regions to create read-only replicas in
			 */
			replicaRegions?: GCPRegion[];
		};

		/**
		 * Backup configuration
		 */
		backups?: {
			/**
			 * Whether or not to enable point in time recovery
			 * Must be true if using replicas
			 */
			pointInTimeRecovery?: boolean;

			/**
			 * Start time for backups (Format: HH:MM)
			 */
			startTime?: string;

			/**
			 * Backup retention settings
			 */
			retentionSettings?: {
				/**
				 * How many backups to retain
				 */
				retainCount?: number;

				/**
				 * How many days to retain transaction logs for (between 1 and 7)
				 */
				transactionLogRetentionDays?: number;
			};
		};
	};

	/**
	 * Key-value store configuration (optional)
	 */
	kv?: ({
		type?: 'redis';
	} & Omit<gcp.redis.InstanceArgs, 'region' | 'authorizedNetwork' | 'authEnabled'>)

	/**
	 * Cloud Run service configuration
	 */
	service?: {
		/**
		 * Service account email to use
		 */
		serviceAccount?: pulumi.Input<string> | Pick<gcp.serviceaccount.Account, 'email'>;

		/**
		 * Grant IAM roles to the service account (default is true)
		 */
		grantIAMRoles?: boolean;

		/**
		 * CPU limit
		 */
		cpuLimit?: number;

		/**
		 * Memory limit in MB
		 */
		memoryLimit?: number;

		/**
		 * Additional metadata annotations
		 */
		annotations?: { [key: string]: pulumi.Input<string> };
	};

	/**
	 * The network of the service: the VPC, the subnet, the VPC connector and
	 * the one private service access connection that a VPC may have. Services
	 * that share a VPC receive the same `AppNetwork`, so the connection is made
	 * once. When it is given the service creates no network resource, and
	 * `vpc` cannot be given (the `AppNetwork` holds those settings).
	 */
	network?: AppNetwork;

	/**
	 * VPC configuration (optional, created automatically if database is enabled).
	 * Giving `vpc.network` builds an `AppNetwork` around that VPC for this service
	 * alone (and warns): services that share a VPC should share an `AppNetwork`.
	 */
	vpc?: {
		/**
		 * Existing VPC to use
		 */
		network?: gcp.compute.Network;

		/**
		 * VPC connector CIDR range
		 */
		connectorCIDR?: string;

		/**
		 * Number of instances of the VPC connector
		 * @default CLOUD_RUN_SERVICE_DEFAULTS.network.connector
		 */
		connector?: {
			minInstances?: number;
			maxInstances?: number;
		};

		/**
		 * Prefix length of the private service access range that the
		 * database is reached through
		 * @default CLOUD_RUN_SERVICE_DEFAULTS.network.psaPrefixLength
		 */
		psaPrefixLength?: number;

		/**
		 * Subnet CIDR range (for database peering)
		 */
		subnetCIDR?: string;

		/**
		 * Deletion policy for service networking connection.
		 * Set to 'ABANDON' to avoid delete failures when Cloud SQL hasn't released the connection.
		 * Default is undefined (normal delete behavior).
		 */
		servicePeeringDeletionPolicy?: 'ABANDON';
	};

	/**
	 * Worker for background tasks/queue processors (optional): a Managed
	 * Instance Group of VMs (`kind: 'mig'`) or a Cloud Run Worker Pool
	 * (`kind: 'crwp'`). Cannot be combined with `mig`.
	 */
	worker?: MigWorkerArgs | CrwpWorkerArgs;

	/**
	 * Worker configuration of 1.0.x (optional, for background workers/queue processors)
	 *
	 * Deprecated (the constructor warns): use `worker`. `mig: { enabled: true, workerKind: 'crwp', ... }`
	 *             becomes `worker: { kind: 'crwp', ... }` (`workerKind`
	 *             defaults to 'mig'), and `enabled: false` becomes no
	 *             `worker` at all
	 */
	mig?: LegacyMigArgs;

	/**
	 * Database migration configuration (optional)
	 * Runs migrations using Cloud Run Job with the same image before starting the service
	 */
	migration?: {
		/**
		 * Whether to enable migrations
		 */
		enabled: boolean;

		/**
		 * Container execution configuration
		 */
		container?: {
			/**
			 * Entrypoint override (e.g., ['node', 'dist/migrate.js'])
			 */
			entrypoint?: string[];

			/**
			 * Arguments passed to the entrypoint
			 */
			args?: string[];
		};

		/**
		 * Additional environment variables specific to migrations
		 * These are merged with the main environment variables
		 */
		environmentOverrides?: { [key: string]: pulumi.Input<string> };

		/**
		 * CPU limit for migration job
		 * @default MIGRATION_DEFAULTS.cpuLimit
		 */
		cpuLimit?: number;

		/**
		 * Memory limit for migration job in MB
		 * @default MIGRATION_DEFAULTS.memoryLimit
		 */
		memoryLimit?: number;

		/**
		 * Task timeout in seconds
		 * @default MIGRATION_DEFAULTS.taskTimeout
		 */
		taskTimeout?: number;
	};

}

/**
 * Cloud Run Backend Service Component
 * Deploys a containerized backend service with optional database and MIG worker
 */
export class CloudRunService extends pulumi.ComponentResource {
	readonly service: gcp.cloudrun.Service;
	readonly database?: PostgresCloudSQL;
	readonly kv?: gcp.redis.Instance;
	readonly network?: AppNetwork;
	readonly vpc?: gcp.compute.Network;
	readonly subnet?: gcp.compute.Subnetwork;
	readonly vpcConnector?: gcp.vpcaccess.Connector;
	readonly backendService: gcp.compute.BackendService;
	readonly serviceAccount?: gcp.serviceaccount.Account | Pick<gcp.serviceaccount.Account, 'email'>;
	readonly mig?: ContainerGeneric;
	readonly migration?: MigrationJob;

	constructor(name: string, args: CloudRunServiceArgs, opts?: pulumi.ComponentResourceOptions) {
		// Parsed before the component registers, so a rejected configuration leaves nothing behind
		const parsed = parseCloudRunServiceArgs(args);

		super('Keeta:GCP:CloudRunService', name, args, opts);

		let vpc: gcp.compute.Network | undefined;
		let subnet: gcp.compute.Subnetwork | undefined;
		let vpcConnector: gcp.vpcaccess.Connector | undefined;
		let appNetwork: AppNetwork | undefined;
		let db: PostgresCloudSQL | undefined;
		let kv: gcp.redis.Instance | undefined;

		const parsedVpc = parsed.vpc;
		if (parsedVpc !== undefined) {
			/*
			 * The network is an AppNetwork: the caller's when it is given, else one
			 * that this service builds for itself (around the VPC of the caller,
			 * if there is one). It owns the VPC, the subnet, the connector and the
			 * one private service access connection.
			 */
			if (parsedVpc.appNetwork === undefined) {
				const own = parsedVpc.network;
				appNetwork = new AppNetwork(name, {
					region: parsed.region,
					network: own.existing,
					subnetCIDR: own.subnetCIDR,
					connectorCIDR: own.connectorCIDR,
					connector: own.connector,
					psaPrefixLength: own.psaPrefixLength,
					servicePeeringDeletionPolicy: own.servicePeeringDeletionPolicy,
					movedFrom: this.urn
				}, { parent: this });
			} else {
				appNetwork = parsedVpc.appNetwork;
			}

			vpc = appNetwork.network;
			subnet = appNetwork.subnet;
			vpcConnector = appNetwork.connector;

			if (parsedVpc.data) {
				const { database } = parsedVpc.data;
				const svcNetworkingConnection = appNetwork.privateServiceAccess();

				db = new PostgresCloudSQL(`${name}-db`, {
					region: parsed.region,
					tier: database.tier,
					databaseVersion: database.version,
					deletionProtection: database.deletionProtection,
					vpcNetwork: vpc,
					insightsConfig: {
						queryInsightsEnabled: database.queryInsights,
						queryStringLength: database.queryStringLength
					},
					flags: database.flags,
					replication: database.replication,
					backups: database.backups
				}, {
					dependsOn: [svcNetworkingConnection],
					parent: this
				});
			}

			if (parsedVpc.kv) {
				kv = new gcp.redis.Instance(generateName(name, 'kv', 32), {
					authEnabled: true,
					authorizedNetwork: vpc.id,
					region: parsed.region,
					...parsedVpc.kv
				}, {
					parent: this,
					dependsOn: [ vpc, vpcConnector ]
				});
			}
		}

		let imageUri: pulumi.Input<string>;
		if (parsed.image.kind === 'uri') {
			imageUri = parsed.image.uri;
		} else {
			const build = parsed.image.build;
			const buildArgs: { [key: string]: pulumi.Input<string> } = { ...build.buildArgs };
			if (build.nodeImage) {
				buildArgs.NODE_IMAGE = build.nodeImage;
			}

			let versioning: ConstructorParameters<typeof components.DockerImage>[1]['versioning'];
			if (build.githubSha) {
				versioning = { type: 'PLAIN', value: build.githubSha };
			} else {
				versioning = { type: 'FILE', fromFile: build.directory };
			}

			let imageConfig: ConstructorParameters<typeof components.DockerImage>[1] = {
				imageName: build.imageName,
				registryUrl: build.registryUrl,
				platform: build.platform,
				provider: callerOf(this, parsed.gcp.project),
				buildArgs,
				buildTarget: build.target,
				buildDirectory: {
					type: 'DIRECTORY',
					directory: build.directory
				},
				versioning,
				secrets: build.secrets
			};

			if (build.remote) {
				const remoteConfig = this.getRemoteConfig(name, parsed, build.remote);
				imageConfig = { ...imageConfig, ...remoteConfig };
			}

			const dockerImage = new components.DockerImage(`${name}-image`, imageConfig, {
				parent: this,
				aliases: movedFrom(`${name}-image`, 'Keeta:GCP:DockerImage', { kind: 'stack' })
			});
			imageUri = dockerImage.uri;
		}

		const identity = new ServiceIdentity(name, {
			gcp: parsed.gcp,
			account: parsed.identity.account,
			grantRoles: parsed.identity.grantRoles,
			app: this,
			database: db,
			worker: parsedVpc?.worker !== undefined
		}, { parent: this });
		const serviceAccount = identity.account;

		let serviceDependsOn: pulumi.Input<pulumi.Resource[]> | undefined = pulumi.all(identity.grants);

		/*
		 * The one environment of the app: the service, the migration job and the
		 * worker read views of it. The worker and the migration job each had a
		 * manager of their own in 1.0.95; a binding of theirs for a secret that
		 * the caller owns stays, retained (see `ReplacedEnvironment`).
		 */
		const parsedWorker = parsedVpc?.worker;
		const replaces: ReplacedEnvironment[] = [];
		if (parsedWorker && vpc && subnet) {
			replaces.push({
				name: `${name}-mig-env`,
				oldParent: { kind: 'resource', urn: this.urn },
				except: Object.keys(parsedWorker.environmentOverrides ?? {})
			});
		}

		const parsedMigration = parsedVpc?.data?.migration;
		if (parsedMigration && db) {
			replaces.push({
				name: `${name}-migration-env`,
				oldParent: { kind: 'resource', urn: pulumi.createUrn(`${name}-migration`, 'Keeta:GCP:MigrationJob', this.urn) },
				except: Object.keys(parsedMigration.environmentOverrides ?? {})
			});
		}

		let envManager: EnvManager | undefined;
		// Create environment manager if we have environment variables OR a database (for auto-injected DB vars) OR Redis
		if (parsed.environment || db || kv) {
			const variables: EnvironmentVariables = {};

			if (db) {
				const hostInfo = db.getHost(parsed.region);
				const dbVars = buildDatabaseEnvVars({
					host: hostInfo.host,
					username: db.username,
					password: db.password,
					databaseName: db.databaseName,
					caCertificate: hostInfo.caCertificate
				});
				Object.assign(variables, dbVars);
			}

			if (kv) {
				const kvVars = buildRedisEnvVars({
					host: kv.host,
					port: kv.port,
					password: kv.authString
				});

				Object.assign(variables, kvVars);
			}

			if (parsed.environment) {
				Object.assign(variables, parsed.environment);
			}

			envManager = new EnvManager(`${name}-env`, {
				serviceAccount: pulumi.interpolate`serviceAccount:${serviceAccount.email}`,
				secretRegionName: parsed.region,
				variables,
				replaces
			}, { parent: this });
		}

		// Create migration job if enabled and database is configured
		let migration: MigrationJob | undefined;
		if (parsedMigration && db) {
			let vpcConfig: { connector: gcp.vpcaccess.Connector } | undefined;
			if (vpcConnector) {
				vpcConfig = { connector: vpcConnector };
			}

			migration = new MigrationJob(`${name}-migration`, {
				gcp: parsed.gcp,
				region: parsed.region,
				database: { instance: db },
				image: imageUri,
				container: parsedMigration.container,
				vpc: vpcConfig,
				serviceAccount: serviceAccount,
				identity,
				cpuLimit: parsedMigration.cpuLimit,
				memoryLimit: parsedMigration.memoryLimit,
				taskTimeout: parsedMigration.taskTimeout,
				env: envManager?.view(parsedMigration.environmentOverrides),
				trigger: imageUri // Re-run migration when image changes
			}, { parent: this });

			// Make Cloud Run service depend on migration completing
			const migrationDep = migration;
			serviceDependsOn = pulumi.output(serviceDependsOn ?? []).apply(function(deps) {
				return([...deps, migrationDep]);
			});
		}

		const annotations: { [key: string]: pulumi.Input<string> } = {
			...parsed.service.annotations
		};

		if (vpcConnector) {
			annotations['run.googleapis.com/vpc-access-connector'] = vpcConnector.selfLink;
		}

		const service = new gcp.cloudrun.Service(`${name}-api`, {
			location: parsed.region,
			template: {
				spec: {
					serviceAccountName: serviceAccount.email,
					containers: [{
						image: imageUri,
						envs: envManager?.view().cloudRun,
						resources: {
							limits: {
								cpu: String(parsed.service.cpuLimit),
								memory: `${parsed.service.memoryLimit}Mi`
							}
						}
					}]
				},
				metadata: {
					annotations
				}
			}
		}, {
			dependsOn: serviceDependsOn,
			parent: this
		});

		new gcp.cloudrun.IamMember(`${name}-invoker`, {
			service: service.name,
			location: service.location,
			role: 'roles/run.invoker',
			member: 'allUsers'
		}, {
			deletedWith: service,
			parent: this,
			aliases: movedFrom(`${name}-invoker`, 'gcp:cloudrun/iamMember:IamMember', { kind: 'resource', urn: service.urn })
		});

		const negType = 'gcp:compute/regionNetworkEndpointGroup:RegionNetworkEndpointGroup';
		const neg = new gcp.compute.RegionNetworkEndpointGroup(`${name}-neg`, {
			region: parsed.region,
			networkEndpointType: 'SERVERLESS',
			cloudRun: {
				service: service.name
			}
		}, {
			deletedWith: service,
			parent: this,
			aliases: movedFrom(`${name}-neg`, negType, { kind: 'resource', urn: service.urn })
		});

		const backendService = new gcp.compute.BackendService(`${name}-backend`, {
			protocol: 'HTTP',
			loadBalancingScheme: 'EXTERNAL_MANAGED',
			backends: [{
				group: neg.id
			}]
		}, {
			parent: this,
			aliases: movedFrom(`${name}-backend`, 'gcp:compute/backendService:BackendService', {
				kind: 'resource',
				urn: legacyUrn(`${name}-neg`, negType, { kind: 'resource', urn: service.urn })
			})
		});

		let mig: ContainerGeneric | undefined;
		const worker = parsedVpc?.worker;
		if (worker && appNetwork) {
			// Enable SSH firewall if requested
			if (worker.kind === 'mig' && worker.enableSSH) {
				appNetwork.allowIapSsh(name, {
					sourceRange: CLOUD_RUN_SERVICE_DEFAULTS.worker.sshIapRange, // GCP IAP range
					priority: CLOUD_RUN_SERVICE_DEFAULTS.worker.sshIapPriority,
					extra: parsed.gcp.firewallConfig
				});
			}

			// The worker reads the environment of the app, with its own overrides
			// (an app without variables has no manager, and the view holds the overrides alone)
			const workerEnv = envManager?.view(worker.environmentOverrides) ?? new EnvView({}, [], worker.environmentOverrides ?? {});

			if (worker.kind === 'mig') {
				// Reserve the external IP if the worker egresses through a NAT
				let natIps: pulumi.Input<string>[] | undefined;
				if (worker.egress === 'vpc+nat') {
					// The reserved address (and so the IP that peers allow) stays; the NAT of the worker uses it
					const extIP = new gcp.compute.Address(`${name}-mig-ext-ip`, {
						description: `[${name}] External IP for MIG`,
						addressType: 'EXTERNAL',
						region: parsed.region
					}, { parent: this });
					natIps = [extIP.selfLink];
				}

				mig = new ContainerMIG(`${name}-mig`, {
					description: `[${name}] MIG worker for background tasks`,
					serviceAccount: serviceAccount.email,
					identity,
					subnetwork: appNetwork.subnet,
					machineType: worker.machineType,
					cosImage: worker.cosImage,
					tags: worker.tags,
					enableVMSSH: worker.enableSSH,
					count: worker.instanceCount,
					diskSizeGb: worker.diskSizeGb,
					egress: worker.egress,
					natIps: natIps,
					common: {
						gcp: parsed.gcp
					},
					containerSpec: {
						containers: [{
							image: imageUri,
							name: `${name}-worker`,
							restartPolicy: 'Always',
							env: workerEnv.resolvedForVm
						}]
					}
				}, { parent: this });
			} else {
				mig = new ContainerCloudRun(`${name}-crwp`, {
					description: `[${name}] Worker for background tasks`,
					serviceAccount: serviceAccount.email,
					identity,
					subnetwork: appNetwork.subnet,
					machineType: worker.machineType,
					tags: worker.tags,
					count: worker.instanceCount,
					egress: worker.egress,
					common: {
						gcp: parsed.gcp
					},
					containerSpec: {
						containers: [{
							image: imageUri,
							name: `${name}-worker`,
							restartPolicy: 'Always',
							env: workerEnv.cloudRunJob
						}]
					}
				}, {
					parent: this
				});
			}
		}

		this.service = service;
		this.database = db;
		this.kv = kv;
		this.network = appNetwork;
		this.vpc = vpc;
		this.subnet = subnet;
		this.vpcConnector = vpcConnector;
		this.backendService = backendService;
		this.serviceAccount = serviceAccount;
		this.mig = mig;
		this.migration = migration;
	}

	private getRemoteConfig(
		name: string,
		parsed: ParsedCloudRunServiceArgs,
		remote: ParsedRemote
	) {
		/*
		 * The project comes from the arguments, as it did when the build had a
		 * provider of its own; the resources of the build now use the provider
		 * of the component, and the build only needs to know who the caller is
		 */
		const provider = callerOf(this, parsed.gcp.project);

		let { bindPermissions, serviceAccount, bucket } = remote;

		if (bindPermissions === undefined && (serviceAccount === undefined || bucket === undefined)) {
			bindPermissions = true;
		}

		if (!serviceAccount) {
			serviceAccount = new gcp.serviceaccount.Account(`${name}-build-sa`, {
				accountId: generateName(name, 'build', 30)
			}, { parent: this });
		}

		if (!bucket) {
			bucket = new gcp.storage.Bucket(generateName(name, 'docker', 55), {
				location: parsed.region,
				forceDestroy: true,
				uniformBucketLevelAccess: true,
				...remote.bucketConfig
			}, { parent: this });
		}

		return({
			provider,
			bindPermissions,
			serviceAccount,
			bucket,
			machineType: remote.machineType,
			timeoutSeconds: remote.timeoutSeconds
		});
	}
}

/**
 * Configuration for a Full Stack Application
 * Combines a static frontend with a Cloud Run backend
 */
export interface FullStackAppArgs {
	/**
	 * Load balancer configuration (domain, SSL, IPs, DNS)
	 */
	loadBalancer: LoadBalancerConfig;

	/**
	 * Frontend (SPA) configuration (without loadBalancer, as it's managed by FullStackApp)
	 */
	frontend: Omit<StaticWebAppArgs, 'loadBalancer'> | null;

	/**
	 * Backend service configuration
	 */
	backend: CloudRunServiceArgs;

	/**
	 * Routing configuration
	 */
	routing?: {
		/**
		 * API path prefix (default: '/api')
		 */
		apiPrefix?: string;

		/**
		 * Static paths to serve from frontend (default: ['/assets/', '/icons/', '/fonts/', '/images/'])
		 */
		staticPaths?: string[];

		/**
		 * Static files to serve from frontend (default: ['/favicon.svg'])
		 */
		staticFiles?: string[];
	};
}

/**
 * Full Stack Application Component
 * Deploys both static frontend and Cloud Run backend with unified load balancer
 * This component composes StaticWebApp and CloudRunService
 */
export class FullStackApp extends pulumi.ComponentResource {
	readonly frontend: StaticWebApp | null;
	readonly backend: CloudRunService;
	readonly urlMap: gcp.compute.URLMap;
	readonly httpsProxy: gcp.compute.TargetHttpsProxy;
	readonly forwardingRules: gcp.compute.GlobalForwardingRule[];
	readonly ips: pulumi.Output<string[]>;
	readonly frontendBucket: pulumi.Output<string> | null;

	constructor(name: string, args: FullStackAppArgs, opts?: pulumi.ComponentResourceOptions) {
		super('Keeta:GCP:FullStackApp', name, args, opts);

		let routeRules: RouteRuleConfig[];

		this.backend = new CloudRunService(`${name}-backend`, args.backend, { parent: this });

		if (args.frontend) {
			const frontend = new StaticWebApp(`${name}-frontend`, args.frontend, { parent: this });
			this.frontend = frontend;
			this.frontendBucket = this.frontend.bucket.name;

			const routing = args.routing ?? {};
			const apiPrefix = routing.apiPrefix ?? '/api';
			const staticPaths = routing.staticPaths ?? ['/assets/', '/icons/', '/fonts/', '/images/'];
			const staticFiles = routing.staticFiles ?? ['/favicon.svg'];

			routeRules = [
				...staticPaths.map((path, priority): RouteRuleConfig => {
					return({
						priority: priority + 1,
						matchRules: [{ prefixMatch: path }],
						service: frontend.backendBucket.id
					});
				}),
				...staticFiles.map((file, priority): RouteRuleConfig => {
					return({
						priority: staticPaths.length + priority + 1,
						matchRules: [{ fullPathMatch: file }],
						service: frontend.backendBucket.id
					});
				}),
				{
					priority: staticPaths.length + staticFiles.length + 1,
					matchRules: [{ prefixMatch: apiPrefix }],
					service: this.backend.backendService.id
				},
				{
					priority: staticPaths.length + staticFiles.length + 2,
					matchRules: [{ pathTemplateMatch: '/**' }],
					service: this.frontend.backendBucket.id,
					routeAction: {
						urlRewrite: {
							pathTemplateRewrite: '/'
						}
					}
				}
			];
		} else {
			this.frontend = null;
			this.frontendBucket = null;

			if (args.routing) {
				throw(new Error('Routing configuration is not applicable when frontend is null'));
			}

			routeRules = [];
		}

		const lbResources = createLoadBalancer(
			name,
			args.loadBalancer,
			routeRules,
			this.frontend ? this.frontend.backendBucket.id : this.backend.backendService.id,
			{ parent: this }
		);

		this.urlMap = lbResources.urlMap;
		this.httpsProxy = lbResources.httpsProxy;
		this.forwardingRules = lbResources.forwardingRules;
		this.ips = lbResources.ips;

		this.registerOutputs({
			frontendBucket: this.frontend ? this.frontend.bucket.name : null,
			backendUrl: this.backend.service.statuses.apply(extractServiceURL),
			ips: this.ips
		});
	}
}
