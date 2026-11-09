import * as pulumi from '@pulumi/pulumi';
import type * as gcp from '@pulumi/gcp';
import type { CloudRunServiceArgs } from './apps';
import type { EnvironmentVariables } from './cloudrun';
import type { GCPCommonOptions } from './common';
import type { GCPRegion } from './constants';
import type { AppNetwork } from './network';
import { BUILD_DEFAULTS, CLOUD_RUN_SERVICE_DEFAULTS, MIGRATION_DEFAULTS, POSTGRES_DEFAULTS } from './defaults';

/**
 * Thrown by `parseCloudRunServiceArgs` (and so by the constructor of
 * `CloudRunService`) when the arguments of the caller are not a valid
 * configuration. The message names the rule that the arguments break.
 */
export class CloudRunServiceArgsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CloudRunServiceArgsError';
	}
}

/**
 * How a worker reaches the internet
 *
 *   - vpc: No external IP, only VPC access (default)
 *   - vpc+direct: External IP automatically assigned for internet access,
 *                 VPC for private access
 *   - vpc+nat: Create a NAT for internet access, VPC for private access
 *              (this is the old "allocateExternalIP" option).  For a
 *              Cloud Run Worker Pool this will create a NAT Router.
 */
export type WorkerEgress = 'vpc' | 'vpc+direct' | 'vpc+nat';

interface EnvironmentOverrides {
	[key: string]: pulumi.Input<string>;
}

interface WorkerCommonArgs {
	/**
	 * Number of instances (default: 1)
	 */
	instanceCount?: number;

	/**
	 * Machine type
	 * @default CLOUD_RUN_SERVICE_DEFAULTS.worker.machineType
	 */
	machineType?: string;

	/**
	 * Additional tags for the instances
	 */
	tags?: string[];

	/**
	 * Type of external access
	 * @default CLOUD_RUN_SERVICE_DEFAULTS.worker.egress
	 */
	egress?: WorkerEgress;

	/**
	 * Additional environment variables specific to the worker
	 * These are merged with the main environment variables
	 */
	environmentOverrides?: EnvironmentOverrides;
}

/**
 * A worker that runs on a Managed Instance Group of VMs
 */
export interface MigWorkerArgs extends WorkerCommonArgs {
	kind: 'mig';

	/**
	 * Container OS image to use
	 */
	cosImage?: string;

	/**
	 * Whether to enable SSH via IAP
	 */
	enableSSH?: boolean;

	/**
	 * Size of the boot disk of each VM, in GB
	 * @default CONTAINER_DEFAULTS.mig.diskSizeGb
	 */
	diskSizeGb?: number;
}

/**
 * A worker that runs on a Cloud Run Worker Pool (more modern -- it has
 * neither a `cosImage`, nor `enableSSH`, nor a disk)
 */
export interface CrwpWorkerArgs extends WorkerCommonArgs {
	kind: 'crwp';
	cosImage?: never;
	enableSSH?: never;
	diskSizeGb?: never;
}

/**
 * The worker of 1.0.x: the fields of a `mig` worker, written with `enabled`
 * and (for a Cloud Run Worker Pool) `workerKind`
 *
 * Deprecated: use `worker`. Kept for 2.x; the constructor warns when it is used.
 */
export type LegacyMigArgs = Omit<MigWorkerArgs, 'kind' | 'diskSizeGb'> & {
	/**
	 * Whether to enable the worker
	 */
	enabled: boolean;

	/**
	 * Kind of worker to create for this:
	 *   - mig: Managed Instance Group (default)
	 *   - crwp: Cloud Run Worker Pool (more modern -- does not support "cosImage", "enableSSH", or "allocateExternalIP")
	 */
	workerKind?: 'mig' | 'crwp';
};

/** Both kinds of worker, as the parser reads them (the types keep the fields of a kind apart, the parser checks them) */
interface WorkerInput extends WorkerCommonArgs {
	kind: 'mig' | 'crwp';
	cosImage?: string;
	enableSSH?: boolean;
	diskSizeGb?: number;
}

interface ParsedWorkerCommon {
	instanceCount?: number;
	machineType: string;
	tags?: string[];
	egress: WorkerEgress;
	environmentOverrides?: EnvironmentOverrides;
}

export interface ParsedMigWorker extends ParsedWorkerCommon {
	kind: 'mig';
	cosImage?: string;
	enableSSH: boolean;
	diskSizeGb?: number;
}

export interface ParsedCrwpWorker extends ParsedWorkerCommon {
	kind: 'crwp';
}

export type ParsedWorker = ParsedMigWorker | ParsedCrwpWorker;

type BuildArgs = NonNullable<CloudRunServiceArgs['image']['build']>;
type RemoteArgs = NonNullable<BuildArgs['remote']>;
type DatabaseArgs = NonNullable<CloudRunServiceArgs['database']>;
type MigrationArgs = NonNullable<CloudRunServiceArgs['migration']>;

export interface ParsedRemote extends RemoteArgs {
	timeoutSeconds: number;
}

export interface ParsedBuild extends BuildArgs {
	registryUrl: pulumi.Input<string>;
	platform: string;
	remote?: ParsedRemote;
}

export type ParsedImage = {
	kind: 'uri';
	uri: pulumi.Input<string>;
} | {
	kind: 'build';
	build: ParsedBuild;
};

export interface ParsedDatabase extends DatabaseArgs {
	tier: string;
	version: string;
	deletionProtection: boolean;
	queryInsights: boolean;
	queryStringLength: number;
	flags: { [key: string]: number };
}

export interface ParsedMigration extends MigrationArgs {
	cpuLimit: number;
	memoryLimit: number;
	taskTimeout: number;
}

export interface ParsedNetwork {
	/** The network of the caller, when there is one (otherwise the component creates it) */
	existing?: gcp.compute.Network;
	subnetCIDR: string;
	connectorCIDR: string;
	connector: {
		minInstances: number;
		maxInstances: number;
	};
	psaPrefixLength: number;
	servicePeeringDeletionPolicy?: 'ABANDON';
}

export interface ParsedService {
	cpuLimit: number;
	memoryLimit: number;
	annotations?: { [key: string]: pulumi.Input<string> };
}

export interface ParsedIdentity {
	/**
	 * Whether the component grants the roles that the service needs: the
	 * caller did not turn it off (`grantIAMRoles`) and did not give the
	 * account (the roles of an account that the caller gave are the caller's)
	 */
	grantRoles: boolean;
	/** The service account of the caller */
	account?: Pick<gcp.serviceaccount.Account, 'email'>;
}

/**
 * The worker, the database (with its migration) and the key-value store are
 * all inside the VPC, so none of them can exist without a network
 */
interface ParsedVpcCommon {
	data?: {
		database: ParsedDatabase;
		migration?: ParsedMigration;
	};
	kv?: NonNullable<CloudRunServiceArgs['kv']>;
	worker?: ParsedWorker;
}

/**
 * Either the network of the caller's `AppNetwork` (the service creates no
 * network resource), or the settings of the network that the service builds
 * for itself. Never both, so the settings of a network that is not built
 * cannot be read.
 */
export type ParsedVpc = ParsedVpcCommon & ({
	network: ParsedNetwork;
	appNetwork?: undefined;
} | {
	network?: undefined;
	appNetwork: AppNetwork;
});

/**
 * The arguments of `CloudRunService` after they are checked and every
 * default is filled in. Nothing reads the arguments of the caller past this.
 */
export interface ParsedCloudRunServiceArgs {
	gcp: GCPCommonOptions;
	region: GCPRegion;
	image: ParsedImage;
	environment?: EnvironmentVariables;
	service: ParsedService;
	identity: ParsedIdentity;
	vpc?: ParsedVpc;
}

function isAccountLike(value: unknown): value is Pick<gcp.serviceaccount.Account, 'email'> {
	return(typeof value === 'object' && value !== null && 'email' in value);
}

function parseImage(args: CloudRunServiceArgs): ParsedImage {
	const { uri, build } = args.image;

	if (uri !== undefined && build !== undefined) {
		throw(new CloudRunServiceArgsError('image.uri and image.build cannot both be provided, give one of them'));
	}

	if (uri !== undefined) {
		return({ kind: 'uri', uri });
	}

	if (build === undefined) {
		throw(new CloudRunServiceArgsError('Either image.uri or image.build must be provided'));
	}

	let remote: ParsedRemote | undefined;
	if (build.remote !== undefined) {
		remote = { ...build.remote, timeoutSeconds: build.remote.timeoutSeconds ?? BUILD_DEFAULTS.timeoutSeconds };
	}

	return({
		kind: 'build',
		build: {
			...build,
			registryUrl: build.registryUrl ?? pulumi.interpolate`${args.region}-${BUILD_DEFAULTS.registry.domain}/${args.gcp.project}/${BUILD_DEFAULTS.registry.repository}`,
			platform: build.platform ?? BUILD_DEFAULTS.platform,
			remote
		}
	});
}

function parseWorkerCommon(worker: WorkerInput): ParsedWorkerCommon {
	return({
		instanceCount: worker.instanceCount,
		machineType: worker.machineType ?? CLOUD_RUN_SERVICE_DEFAULTS.worker.machineType,
		tags: worker.tags,
		egress: worker.egress ?? CLOUD_RUN_SERVICE_DEFAULTS.worker.egress,
		environmentOverrides: worker.environmentOverrides
	});
}

function parseWorker(worker: WorkerInput): ParsedWorker {
	switch (worker.kind) {
		case 'mig':
			return({
				kind: 'mig',
				...parseWorkerCommon(worker),
				cosImage: worker.cosImage,
				enableSSH: worker.enableSSH === true,
				diskSizeGb: worker.diskSizeGb
			});
		case 'crwp':
			if (worker.enableSSH) {
				throw(new CloudRunServiceArgsError('enableSSH is not supported for Cloud Run Worker Pool (crwp)'));
			}

			if (worker.cosImage !== undefined) {
				throw(new CloudRunServiceArgsError('cosImage is not supported for Cloud Run Worker Pool (crwp)'));
			}

			if (worker.diskSizeGb !== undefined) {
				throw(new CloudRunServiceArgsError('diskSizeGb is not supported for Cloud Run Worker Pool (crwp)'));
			}

			return({ kind: 'crwp', ...parseWorkerCommon(worker) });
		default:
			throw(new CloudRunServiceArgsError('worker.kind must be "mig" or "crwp"'));
	}
}

/**
 * The legacy `mig` is a worker written the old way. This reads it as the
 * `worker` that it stands for, or as no worker when it is disabled.
 */
function workerOfLegacy(mig: LegacyMigArgs): WorkerInput | undefined {
	const { enabled, workerKind, ...rest } = mig;
	if (!enabled) {
		return(undefined);
	}

	void pulumi.log.warn('CloudRunService: the `mig` argument is deprecated and will be removed in the next major version, use `worker` instead (for example `worker: { kind: \'crwp\' }` for `mig: { enabled: true, workerKind: \'crwp\' }`)');

	let kind: WorkerInput['kind'] = 'mig';
	if (workerKind === 'crwp') {
		kind = 'crwp';
	}

	return({ kind, ...rest });
}

function parseWorkerArgs(args: CloudRunServiceArgs): ParsedWorker | undefined {
	if (args.mig !== undefined && args.worker !== undefined) {
		throw(new CloudRunServiceArgsError('mig and worker cannot both be provided, mig is the deprecated form of worker'));
	}

	let worker: WorkerInput | undefined = args.worker;
	if (args.mig !== undefined) {
		worker = workerOfLegacy(args.mig);
	}

	if (worker === undefined) {
		return(undefined);
	}

	return(parseWorker(worker));
}

function parseDatabase(database: DatabaseArgs): ParsedDatabase {
	return({
		...database,
		tier: database.tier ?? POSTGRES_DEFAULTS.tier,
		version: database.version ?? POSTGRES_DEFAULTS.version,
		deletionProtection: database.deletionProtection ?? false,
		queryInsights: database.queryInsights ?? false,
		queryStringLength: database.queryStringLength ?? POSTGRES_DEFAULTS.queryStringLength,
		flags: {
			max_connections: POSTGRES_DEFAULTS.maxConnections,
			...database.flags
		}
	});
}

function parseMigration(migration: MigrationArgs): ParsedMigration {
	return({
		...migration,
		cpuLimit: migration.cpuLimit ?? MIGRATION_DEFAULTS.cpuLimit,
		memoryLimit: migration.memoryLimit ?? MIGRATION_DEFAULTS.memoryLimit,
		taskTimeout: migration.taskTimeout ?? MIGRATION_DEFAULTS.taskTimeout
	});
}

function parseNetwork(vpc: CloudRunServiceArgs['vpc']): ParsedNetwork {
	return({
		existing: vpc?.network,
		subnetCIDR: vpc?.subnetCIDR ?? CLOUD_RUN_SERVICE_DEFAULTS.network.subnetCIDR,
		connectorCIDR: vpc?.connectorCIDR ?? CLOUD_RUN_SERVICE_DEFAULTS.network.connectorCIDR,
		connector: {
			minInstances: vpc?.connector?.minInstances ?? CLOUD_RUN_SERVICE_DEFAULTS.network.connector.minInstances,
			maxInstances: vpc?.connector?.maxInstances ?? CLOUD_RUN_SERVICE_DEFAULTS.network.connector.maxInstances
		},
		psaPrefixLength: vpc?.psaPrefixLength ?? CLOUD_RUN_SERVICE_DEFAULTS.network.psaPrefixLength,
		servicePeeringDeletionPolicy: vpc?.servicePeeringDeletionPolicy
	});
}

function parseIdentity(service: CloudRunServiceArgs['service']): ParsedIdentity {
	const account = service?.serviceAccount;
	if (!account) {
		return({ grantRoles: service?.grantIAMRoles !== false });
	}

	if (isAccountLike(account)) {
		return({ grantRoles: false, account });
	}

	return({ grantRoles: false, account: { email: pulumi.output(account) }});
}

/**
 * Checks the arguments of `CloudRunService` and fills in every default.
 * This is the only place that reads them: the constructor works from the
 * result. The arguments of the caller are not changed.
 *
 * @throws CloudRunServiceArgsError when the arguments break a rule
 */
export function parseCloudRunServiceArgs(args: CloudRunServiceArgs): ParsedCloudRunServiceArgs {
	const image = parseImage(args);
	const worker = parseWorkerArgs(args);

	if (args.migration?.enabled && !args.database) {
		throw(new CloudRunServiceArgsError('migration.enabled requires database'));
	}

	const parsed: ParsedCloudRunServiceArgs = {
		gcp: args.gcp,
		region: args.region,
		image,
		environment: args.environment,
		service: {
			cpuLimit: args.service?.cpuLimit ?? CLOUD_RUN_SERVICE_DEFAULTS.service.cpuLimit,
			memoryLimit: args.service?.memoryLimit ?? CLOUD_RUN_SERVICE_DEFAULTS.service.memoryLimit,
			annotations: args.service?.annotations
		},
		identity: parseIdentity(args.service)
	};

	if (args.network !== undefined && args.vpc !== undefined) {
		throw(new CloudRunServiceArgsError('network and vpc cannot both be provided: the AppNetwork owns the VPC, the subnet and the connector, give one of them'));
	}

	if (args.network !== undefined && args.network.region !== args.region) {
		throw(new CloudRunServiceArgsError(`network is in ${args.network.region} but the service is in ${args.region}: the subnet and the connector of an AppNetwork serve one region, so give the service the region of its network`));
	}

	if (args.database || args.kv || args.vpc || args.network || worker !== undefined) {
		const common: ParsedVpcCommon = { kv: args.kv, worker };
		let vpc: ParsedVpc;
		if (args.network !== undefined) {
			vpc = { ...common, appNetwork: args.network };
		} else {
			vpc = { ...common, network: parseNetwork(args.vpc) };
		}

		if (args.vpc?.network !== undefined) {
			void pulumi.log.warn('CloudRunService: vpc.network builds a network of its own around the VPC. Services that share a VPC need one private service access connection between them: build one AppNetwork (new AppNetwork(name, { network, ... })) and pass it to each of them as `network`');
		}

		if (args.database) {
			vpc.data = { database: parseDatabase(args.database) };

			if (args.migration?.enabled) {
				vpc.data.migration = parseMigration(args.migration);
			}
		}

		if (worker?.egress === 'vpc+nat' && args.network !== undefined && !args.network.claimNatWorker()) {
			throw(new CloudRunServiceArgsError('worker.egress \'vpc+nat\' is already used by another worker on this AppNetwork: a network has one Cloud NAT worker, so give the second worker egress \'vpc\' or its own AppNetwork'));
		}

		parsed.vpc = vpc;
	}

	return(parsed);
}
