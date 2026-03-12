import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { extractServiceURL } from './common';
import type { GCPCommonOptions } from './common';
import type { GCPRegion } from './constants';
import type { EnvironmentVariables } from './cloudrun';
import { GoogleCloudFolderWithArgs } from './bucket';
import { EnvManager } from './cloudrun';
import { PostgresCloudSQL } from './sql';
import { ContainerMIG } from './container';
import { MigrationJob } from './migration';
import { buildDatabaseEnvVars } from './database-env';
import { createHttpRedirect } from './lb';
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
	sslCertificate: Pick<gcp.compute.ManagedSslCertificate, 'id'>;
	domains?: never;
	protectCert?: never;
}

interface DomainsConfig {
	domains: pulumi.Input<string[]>;
	protectCert?: boolean;
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
	let sslCertificate: Pick<gcp.compute.ManagedSslCertificate, 'id'>;
	if ('sslCertificate' in config.ssl && config.ssl.sslCertificate) {
		sslCertificate = config.ssl.sslCertificate;
	} else {
		sslCertificate = new gcp.compute.ManagedSslCertificate(`${name}-cert`, {
			managed: {
				domains: config.ssl.domains
			}
		}, {
			...opts,
			protect: config.ssl.protectCert,
			deleteBeforeReplace: true
		});
	}

	// Create HTTPS proxy
	const httpsProxy = new gcp.compute.TargetHttpsProxy(`${name}-https-proxy`, {
		urlMap: urlMap.id,
		sslCertificates: [sslCertificate.id]
	}, opts);

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

	createHttpRedirect(name, ipAddresses, { parent: urlMap });

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
	fileFilter?: (file: string) => boolean;

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
		});

		new gcp.storage.BucketIAMMember(`${name}-bucket-viewer`, {
			bucket: bucket.name,
			role: 'roles/storage.objectViewer',
			member: 'allUsers'
		}, {
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
			options: {
				generated: function(fileName: string) {
					let ttl: number;
					let retainOnDelete = false;
					let retainDays: number | undefined = undefined;
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
						retainDays = 7;
					} else {
						ttl = defaultTTL;
					}
					return({
						cacheControl: `public, max-age=${ttl}`,
						retention: (retainOnDelete && retainDays) ? {
							retainUntilTime: new Date(Date.now() + (retainDays * 24 * 60 * 60 * 1000)).toISOString(),
							mode: 'Unlocked'
						} : undefined,
						retainOnDelete: retainOnDelete
					});
				}
			}
		});

		const backendBucket = new gcp.compute.BackendBucket(`${name}-backend`, {
			bucketName: bucket.name,
			enableCdn: false
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
	 * Docker image configuration
	 */
	image: {
		/**
		 * Docker image URI or configuration to build
		 */
		uri?: pulumi.Input<string>;

		/**
		 * Build configuration (alternative to uri)
		 */
		build?: {
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
	 * VPC configuration (optional, created automatically if database is enabled)
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
	 * Managed Instance Group configuration (optional, for background workers/queue processors)
	 */
	mig?: {
		/**
		 * Whether to enable the MIG worker
		 */
		enabled: boolean;

		/**
		 * Number of instances (default: 1)
		 */
		instanceCount?: number;

		/**
		 * Machine type (default: 'e2-micro')
		 */
		machineType?: string;

		/**
		 * Container OS image to use
		 */
		cosImage?: string;

		/**
		 * Whether to enable SSH via IAP
		 */
		enableSSH?: boolean;

		/**
		 * Additional tags for the instances
		 */
		tags?: string[];

		/**
		 * Whether to allocate an external IP
		 */
		allocateExternalIP?: boolean;

		/**
		 * Additional environment variables specific to the MIG worker
		 * These are merged with the main environment variables
		 */
		environmentOverrides?: { [key: string]: pulumi.Input<string> };
	};

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
		 * CPU limit for migration job (default: 1)
		 */
		cpuLimit?: number;

		/**
		 * Memory limit for migration job in MB (default: 512)
		 */
		memoryLimit?: number;

		/**
		 * Task timeout in seconds (default: 600)
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
	readonly vpc?: gcp.compute.Network;
	readonly subnet?: gcp.compute.Subnetwork;
	readonly vpcConnector?: gcp.vpcaccess.Connector;
	readonly backendService: gcp.compute.BackendService;
	readonly serviceAccount?: gcp.serviceaccount.Account | Pick<gcp.serviceaccount.Account, 'email'>;
	readonly mig?: ContainerMIG;
	readonly migration?: MigrationJob;

	constructor(name: string, args: CloudRunServiceArgs, opts?: pulumi.ComponentResourceOptions) {
		super('Keeta:GCP:CloudRunService', name, args, opts);

		let vpc: gcp.compute.Network | undefined;
		let subnet: gcp.compute.Subnetwork | undefined;
		let vpcConnector: gcp.vpcaccess.Connector | undefined;
		let db: PostgresCloudSQL | undefined;

		if (args.database || args.vpc || args.mig?.enabled) {
			vpc = args.vpc?.network ?? new gcp.compute.Network(`${name}-vpc`, {
				description: `[${name}] VPC network`,
				autoCreateSubnetworks: false
			}, { parent: this });

			const subnetCIDR = args.vpc?.subnetCIDR ?? '10.97.35.0/24';
			subnet = new gcp.compute.Subnetwork(`${name}-subnet`, {
				description: `[${name}] Subnet`,
				network: vpc.selfLink,
				region: args.region,
				ipCidrRange: subnetCIDR,
				privateIpGoogleAccess: true
			}, { parent: vpc });

			const connectorCIDR = args.vpc?.connectorCIDR ?? '10.97.36.0/28';
			const connectorName = generateName(name, 'vpc', 25);
			vpcConnector = new gcp.vpcaccess.Connector(`${name}-vpc-connector`, {
				name: connectorName,
				ipCidrRange: connectorCIDR,
				minInstances: 2,
				maxInstances: 3,
				network: vpc.selfLink,
				region: args.region
			}, { parent: subnet });

			if (args.database) {
				const privateIpAlloc = new gcp.compute.GlobalAddress(`${name}-private-ip-alloc`, {
					purpose: 'VPC_PEERING',
					addressType: 'INTERNAL',
					prefixLength: 16,
					network: vpc.selfLink
				}, { parent: vpc });

				const svcNetworkingConnection = new gcp.servicenetworking.Connection(`${name}-svc-networking`, {
					network: vpc.selfLink,
					service: 'servicenetworking.googleapis.com',
					reservedPeeringRanges: [privateIpAlloc.name],
					deletionPolicy: args.vpc?.servicePeeringDeletionPolicy
				}, { parent: privateIpAlloc });

				db = new PostgresCloudSQL(`${name}-db`, {
					region: args.region,
					tier: args.database.tier ?? 'db-f1-micro',
					deletionProtection: args.database.deletionProtection ?? false,
					vpcNetwork: vpc,
					insightsConfig: {
						queryInsightsEnabled: args.database.queryInsights ?? false,
						queryStringLength: 4500
					},
					flags: {
						max_connections: 25000,
						...args.database.flags
					},
					replication: args.database.replication,
					backups: args.database.backups
				}, {
					dependsOn: [svcNetworkingConnection],
					parent: this
				});
			}
		}

		let imageUri: pulumi.Input<string>;
		if (args.image.uri) {
			imageUri = args.image.uri;
		} else if (args.image.build) {
			const build = args.image.build;
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
				registryUrl: build.registryUrl ?? pulumi.interpolate`${args.region}-docker.pkg.dev/${args.gcp.project}/keeta`,
				platform: build.platform ?? 'linux/amd64',
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
				const remoteConfig = this.getRemoteConfig(name, args, build.remote);
				imageConfig = { ...imageConfig, ...remoteConfig };
			}

			const dockerImage = new components.DockerImage(`${name}-image`, imageConfig);
			imageUri = dockerImage.uri;
		} else {
			throw(new Error('Either image.uri or image.build must be provided'));
		}

		let serviceAccount: Pick<gcp.serviceaccount.Account, 'email'>;
		if (args.service?.serviceAccount) {
			if (typeof args.service.serviceAccount === 'object' && args.service.serviceAccount !== null && 'email' in args.service.serviceAccount) {
				serviceAccount = args.service.serviceAccount;
			} else {
				serviceAccount = { email: pulumi.output(args.service.serviceAccount) };
			}
		} else {
			const accountId = generateName(name, 'sa', 30);

			serviceAccount = new gcp.serviceaccount.Account(`${name}-sa`, {
				description: `[${name}] Service account`,
				accountId
			}, { parent: this });
		}

		let serviceDependsOn: pulumi.Input<pulumi.Resource[]> | undefined = undefined;
		if (args.service?.grantIAMRoles !== false && !args.service?.serviceAccount) {
			if (args.gcp.changeProjectIAMPolicy) {
				const resource = args.gcp.changeProjectIAMPolicy('roles/logging.logWriter', [
					pulumi.interpolate`serviceAccount:${serviceAccount.email}`
				]);

				if (resource) {
					serviceDependsOn = pulumi.output(resource).apply(function(unwrappedResource) {
						return([unwrappedResource]);
					});
				}
			} else {
				const resource = new gcp.projects.IAMMember(`${name}-log-writer`, {
					project: args.gcp.project,
					role: 'roles/logging.logWriter',
					member: pulumi.interpolate`serviceAccount:${serviceAccount.email}`
				}, { parent: this });
				serviceDependsOn = [resource];
			}
		}

		// Grant Cloud SQL client role if database is enabled
		if (db && args.service?.grantIAMRoles !== false && !args.service?.serviceAccount) {
			const cloudsqlClient = new gcp.projects.IAMMember(`${name}-cloudsql-client`, {
				project: args.gcp.project,
				role: 'roles/cloudsql.client',
				member: pulumi.interpolate`serviceAccount:${serviceAccount.email}`
			}, { parent: db });
			serviceDependsOn = pulumi.output(serviceDependsOn ?? []).apply(function(deps) {
				return([...deps, cloudsqlClient]);
			});
		}

		// Create migration job if enabled and database is configured
		let migration: MigrationJob | undefined;
		if (args.migration?.enabled && db) {
			let vpcConfig: { connector: gcp.vpcaccess.Connector } | undefined;
			if (vpcConnector) {
				vpcConfig = { connector: vpcConnector };
			}

			migration = new MigrationJob(`${name}-migration`, {
				gcp: args.gcp,
				region: args.region,
				database: { instance: db },
				image: imageUri,
				container: args.migration.container,
				vpc: vpcConfig,
				serviceAccount: serviceAccount,
				cpuLimit: args.migration.cpuLimit,
				memoryLimit: args.migration.memoryLimit,
				taskTimeout: args.migration.taskTimeout,
				environment: { ...args.environment, ...args.migration.environmentOverrides },
				trigger: imageUri // Re-run migration when image changes
			}, { parent: this });

			// Make Cloud Run service depend on migration completing
			const migrationDep = migration;
			serviceDependsOn = pulumi.output(serviceDependsOn ?? []).apply(function(deps) {
				return([...deps, migrationDep]);
			});
		}

		let envManager: EnvManager | undefined;
		// Create environment manager if we have environment variables OR a database (for auto-injected DB vars)
		if (args.environment || db) {
			const variables: EnvironmentVariables = {};

			if (db) {
				const hostInfo = db.getHost(args.region);
				const dbVars = buildDatabaseEnvVars({
					host: hostInfo.host,
					username: db.username,
					password: db.password,
					databaseName: db.databaseName,
					caCertificate: hostInfo.caCertificate
				});
				Object.assign(variables, dbVars);
			}

			if (args.environment) {
				Object.assign(variables, args.environment);
			}

			envManager = new EnvManager(`${name}-env`, {
				serviceAccount: pulumi.interpolate`serviceAccount:${serviceAccount.email}`,
				secretRegionName: args.region,
				variables
			}, { parent: this });
		}

		const annotations: { [key: string]: pulumi.Input<string> } = {
			...args.service?.annotations
		};

		if (vpcConnector) {
			annotations['run.googleapis.com/vpc-access-connector'] = vpcConnector.selfLink;
		}

		const service = new gcp.cloudrun.Service(`${name}-api`, {
			location: args.region,
			template: {
				spec: {
					serviceAccountName: serviceAccount.email,
					containers: [{
						image: imageUri,
						envs: envManager?.variableOutput,
						resources: {
							limits: {
								cpu: String(args.service?.cpuLimit ?? 1),
								memory: `${args.service?.memoryLimit ?? 512}Mi`
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
			parent: service
		});

		const neg = new gcp.compute.RegionNetworkEndpointGroup(`${name}-neg`, {
			region: args.region,
			networkEndpointType: 'SERVERLESS',
			cloudRun: {
				service: service.name
			}
		}, { parent: service });

		const backendService = new gcp.compute.BackendService(`${name}-backend`, {
			protocol: 'HTTP',
			loadBalancingScheme: 'EXTERNAL_MANAGED',
			backends: [{
				group: neg.id
			}]
		}, { parent: neg });

		let mig: ContainerMIG | undefined;
		if (args.mig?.enabled && vpc && subnet) {
			// Enable SSH firewall if requested
			if (args.mig.enableSSH) {
				new gcp.compute.Firewall(`${name}-ssh-iap-firewall`, {
					description: `[${name}] Allow SSH access to MIG instances via IAP`,
					network: vpc.id,
					direction: 'INGRESS',
					sourceRanges: ['35.235.240.0/20'], // GCP IAP range
					priority: 900,
					allows: [{
						protocol: 'tcp',
						ports: ['22']
					}],
					...args.gcp.firewallConfig
				}, { parent: vpc });
			}

			// Build MIG environment variables through EnvManager (resolves secrets at deploy time)
			const migVariables: { [key: string]: pulumi.Input<string> | { value: pulumi.Input<string>; secret: boolean }} = {};

			if (db) {
				const hostInfo = db.getHost(args.region);
				const dbVars = buildDatabaseEnvVars({
					host: hostInfo.host,
					username: db.username,
					password: db.password,
					databaseName: db.databaseName,
					caCertificate: hostInfo.caCertificate
				});
				Object.assign(migVariables, dbVars);
			}

			if (args.environment) {
				Object.assign(migVariables, args.environment);
			}
			if (args.mig.environmentOverrides) {
				Object.assign(migVariables, args.mig.environmentOverrides);
			}

			const migEnvManager = new EnvManager(`${name}-mig-env`, {
				serviceAccount: pulumi.interpolate`serviceAccount:${serviceAccount.email}`,
				secretRegionName: args.region,
				variables: migVariables
			}, { parent: this });

			const migEnvVars = migEnvManager.resolvedVariableOutput;

			// Create external IP if requested
			let extIP: gcp.compute.Address | undefined;
			if (args.mig.allocateExternalIP) {
				extIP = new gcp.compute.Address(`${name}-mig-ext-ip`, {
					description: `[${name}] External IP for MIG`,
					addressType: 'EXTERNAL',
					region: args.region
				}, { parent: this });
			}

			mig = new ContainerMIG(`${name}-mig`, {
				description: `[${name}] MIG worker for background tasks`,
				serviceAccount: serviceAccount.email,
				subnetwork: subnet,
				machineType: args.mig.machineType ?? 'e2-micro',
				cosImage: args.mig.cosImage,
				tags: args.mig.tags,
				enableVMSSH: args.mig.enableSSH,
				count: args.mig.instanceCount,
				networkInterfaces: extIP ? [{
					accessConfigs: [{
						natIp: extIP.address
					}]
				}] : undefined,
				common: {
					gcp: args.gcp
				},
				containerSpec: {
					containers: [{
						image: imageUri,
						name: `${name}-worker`,
						restartPolicy: 'Always',
						env: migEnvVars
					}]
				}
			}, { parent: this });
		}

		this.service = service;
		this.database = db;
		this.vpc = vpc;
		this.subnet = subnet;
		this.vpcConnector = vpcConnector;
		this.backendService = backendService;
		this.serviceAccount = serviceAccount;
		this.mig = mig;
		this.migration = migration;

		const serviceOutputs: { [key: string]: unknown } = {
			serviceUrl: service.statuses.apply(extractServiceURL),
			backendService: backendService.id
		};
		if (mig) {
			serviceOutputs.mig = mig.instanceGroupManager.id;
		}
		if (migration) {
			serviceOutputs.migrationStatus = migration.status;
		}

		this.registerOutputs(serviceOutputs);
	}

	private getRemoteConfig(
		name: string,
		args: CloudRunServiceArgs,
		remote: NonNullable<NonNullable<CloudRunServiceArgs['image']['build']>['remote']>
	) {
		const provider = new gcp.Provider(`${name}-build-provider`, {
			project: args.gcp.project,
			region: args.region
		}, { parent: this });

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
				location: args.region,
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
			machineType: remote.machineType
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
