import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import * as random from '@pulumi/random';
import type { GCPRegion, PerGCPRegion } from './constants';

type VPCNetworkLike = Pick<gcp.compute.Network, 'id' | 'name'>;

interface SingleDBHost {
	/**
	 * Hostname/IP of database
	 */
	host: pulumi.Output<string>;

	/**
	 * Port to use when connecting to the database
	 */
	port: pulumi.Output<string>;

	/**
	 * Cloud SQL Connection name
	 */
	connectionName: pulumi.Output<string>;

	/**
	 * Certificate information
	 */
	tlsCertificate: pulumi.Output<string>;
}

interface DBConnectivityOutput {
	username: pulumi.Input<string>;
	password: pulumi.Input<string>;
	databaseName: string;
}

interface DBConnectivityArgs extends Partial<Omit<DBConnectivityOutput, 'username'>>, Pick<DBConnectivityOutput, 'username'> {
	maxConnections?: number;

	tls?: {
		requireSSLInURL?: boolean;
		requireClientCertificate?: boolean;
	};
}

export interface PostgresCloudSQLArgs {
	prefix?: string;

	/**
	 * The VPC Network to create the ip/private service connection within
	 */
	vpcNetwork: VPCNetworkLike;

	/**
	 * The region to deploy cloud sql and its dependencies to
	 */
	region: GCPRegion;

	/**
	 * Whether or not to allow this instance to be deleted
	 */
	deletionProtection?: boolean;

	/**
	 * The database tier, specifying what instances it will be running
	 */
	tier: string;

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
	}

	backups?: {
		/**
		 * Whether or not to enable point in time recovery
		 * Must be true if using replicas
		 */
		pointInTimeRecovery?: boolean;

		/**
		 * Start time for backups
		 * Format: HH:MM
		 */
		startTime?: string;

		retentionSettings?: {
			/**
			 * How many backups to retain
			 */
			retainCount?: number;
			/**
			 * How many days to retain transaction logs for
			 * Between 1 and 7
			 *
			 * Must be below retainCount
			 */
			transactionLogRetentionDays?: number;
		}
	}

	/**
	 * Specify a username and optionally override a password to use when creating the database user
	 */
	connectivity: DBConnectivityArgs;
}

type PostgresURLParams = {
	[key: string]: string | number | undefined,

	/**
	 * Postgres Pool Size
	 */
	connection_limit?: number
};

export class PostgresCloudSQL extends pulumi.ComponentResource {
	/**
	 * Create a random string to be used as the postgres password
	 */
	private makePostgresPassword() {
		return new random.RandomString(`${this.#prefix}-postgres-password`, {
			length: 24,
			special: false,
			number: true
		}, { parent: this }).result;
	}

	#prefix: string;
	#options: PostgresCloudSQLArgs;

	readonly hosts: PerGCPRegion<SingleDBHost> = {};
	readonly primaryRegion: GCPRegion;
	readonly usingReplicas: boolean;
	readonly connectivity: DBConnectivityOutput;

	#vpcNetwork: VPCNetworkLike;

	constructor(name: string, args: PostgresCloudSQLArgs, opts?: pulumi.ComponentResourceOptions) {
		super('Keeta:GCP:CloudSQL', name, args, opts);

		this.#prefix = args.prefix ?? name;
		this.#options = args;

		this.#vpcNetwork = args.vpcNetwork;
		this.primaryRegion = args.region;

		this.connectivity = {
			username: args.connectivity.username,
			password: args.connectivity?.password ?? this.makePostgresPassword(),
			databaseName: args.connectivity.databaseName ?? 'main'
		};

		const replicaRegions = args.replication?.replicaRegions ?? [];
		this.usingReplicas = replicaRegions.length > 0;

		/**
		 * Create a private IP address for the SQL instance use
		 */
		const privateIpAddress = new gcp.compute.GlobalAddress(`${this.#prefix}-postgres-private-ip`, {
			purpose: 'VPC_PEERING',
			addressType: 'INTERNAL',
			prefixLength: 16,
			network: this.#vpcNetwork.id
		}, { parent: this });

		/**
		 * Create a private VPC connection for SQL to be able to connect to the subnet
		 */
		const privateVpcConnection = new gcp.servicenetworking.Connection(`${this.#prefix}-postgres-vpc-connection`, {
			network: this.#vpcNetwork.id,
			service: 'servicenetworking.googleapis.com',
			reservedPeeringRanges: [privateIpAddress.name]
		}, { parent: privateIpAddress });

		/**
		 * Create Postgres instance/database/user
		 */
		if (replicaRegions.includes(this.primaryRegion)) {
			throw new Error('Primary region cannot be included in the list of regions (Postgres)');
		}

		/**
		 * Create the master database instance
		 * This will be created no matter what replication is set to
		 */
		const masterDatabase = this.createPostgres(`${this.#prefix}-master-instance`, this.primaryRegion, undefined, {
			parent: this,
			dependsOn: [ privateVpcConnection ]
		});

		this.hosts[this.primaryRegion] = masterDatabase.hostConfig;

		/**
		 * Loop over replica regions and create instances for each
		 */
		for (const region of replicaRegions) {
			if (this.hosts[region]) {
				throw new Error(`Region ${region} already exists in the list of hosts (Postgres)`);
			}

			/**
			 * Create the replica instance, with the master instance as the parent
			 */
			this.hosts[region] = this.createPostgres(`${this.#prefix}-${region}-replica-instance`, region, masterDatabase.instance, {
				parent: masterDatabase.instance
			}).hostConfig;
		}

		/**
		 * Create the database and user
		 * These will replicate to all instances from master
		 */
		new gcp.sql.Database(`${this.#prefix}-db`, {
			name: this.connectivity.databaseName,
			instance: masterDatabase.instance.name,
			deletionPolicy: 'ABANDON'
		}, { parent: masterDatabase.instance, protect: args.deletionProtection });

		new gcp.sql.User(`${this.#prefix}-db-user`, {
			instance: masterDatabase.instance.name,
			name: this.connectivity.username,
			password: this.connectivity.password,
			deletionPolicy: 'ABANDON'
		}, { parent: masterDatabase.instance });
	}

	createPostgres(name: string, region: GCPRegion, masterInstance?: gcp.sql.DatabaseInstance, options?: pulumi.ComponentResourceOptions) {
		let backupConfiguration: NonNullable<pulumi.Unwrap<ConstructorParameters<typeof gcp.sql.DatabaseInstance>[1]['settings']>>['backupConfiguration'];

		const { backups, deletionProtection, tier, replication, connectivity } = this.#options;

		if (region === this.primaryRegion) {
			if (backups !== undefined) {
				backupConfiguration = {
					enabled: true,
					pointInTimeRecoveryEnabled: backups.pointInTimeRecovery,
					startTime: backups.startTime,
					transactionLogRetentionDays: backups.retentionSettings?.transactionLogRetentionDays
				};

				if (backups.retentionSettings?.retainCount !== undefined) {
					backupConfiguration.backupRetentionSettings = {
						retainedBackups: backups.retentionSettings?.retainCount
					};
				}
			}

			if (this.usingReplicas) {
				if (!backupConfiguration?.enabled || !backupConfiguration?.pointInTimeRecoveryEnabled) {
					throw new Error('Point-in-time recovery must be enabled for backups when using replicas (Postgres)');
				}
			}
		}

		let availabilityType = 'ZONAL';
		if (replication?.multiZone) {
			availabilityType = 'REGIONAL';
		}

		if (availabilityType !== 'REGIONAL' && this.usingReplicas) {
			throw new Error('Multi-zone must be enabled when using replicas (Postgres)');
		}

		const databaseFlags = [];
		if (connectivity.maxConnections !== undefined) {
			databaseFlags.push({
				name: 'max_connections',
				value: String(connectivity.maxConnections)
			});
		}

		const instance = new gcp.sql.DatabaseInstance(name, {
			region: region,
			databaseVersion: 'POSTGRES_14',
			deletionProtection: deletionProtection,
			masterInstanceName: masterInstance?.name,
			settings: {
				availabilityType: availabilityType,
				tier: tier,
				ipConfiguration: {
					ipv4Enabled: false,
					privateNetwork: this.#vpcNetwork.id,
					requireSsl: this.#options.connectivity.tls?.requireClientCertificate
				},
				databaseFlags: databaseFlags,
				backupConfiguration: backupConfiguration
			}
		}, {
			protect: deletionProtection,
			...options
		});

		const hostConfig: SingleDBHost = {
			host: instance.firstIpAddress,
			port: pulumi.output('5432'),
			tlsCertificate: instance.serverCaCerts[0].cert,
			connectionName: instance.connectionName
		};

		return({ hostConfig, instance });
	}

	getHost(region: GCPRegion) {
		const host = this.hosts[this.primaryRegion];

		if (!host) {
			throw new Error(`Host does not exist: ${region}`);
		}

		return host;
	}

	getHostCidrRange(region: GCPRegion) {
		const { host } = this.getHost(region);
		return pulumi.interpolate`${host}/32`;
	}

	getPrimaryHostCIDR() {
		return this.getHostCidrRange(this.primaryRegion);
	}

	getPrimaryHost() {
		return this.getHost(this.primaryRegion);
	}

	getPrimaryHostURL(additionalParams?: pulumi.Input<PostgresURLParams>) {
		const selectedHost = this.getHost(this.primaryRegion);

		return pulumi.all([selectedHost, this.connectivity, additionalParams]).apply(([selected, connectivity, resolvedParams]) => {
			const { host, port } = selected;
			const { username, password, databaseName } = connectivity;
			const url = new URL(`postgres://${username}:${password}@${host}:${port}/${databaseName}`);

			// Add any additional params
			for (const [key, value] of Object.entries(resolvedParams ?? {})) {
				if (value === undefined) {
					continue;
				}

				url.searchParams.set(key, String(value));
			}

			// Default to requiring SSL, unless explicitly set to false
			let sslMode = 'require';
			if (this.#options.connectivity.tls?.requireSSLInURL === false) {
				sslMode = 'prefer';
			} else {
				url.searchParams.set('sslaccept', 'strict');
			}

			url.searchParams.set('sslmode', sslMode);

			return url.toString();
		});
	}
}
