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
	 * CA Certificate PEM
	 */
	caTlsCertificate: pulumi.Output<string>;
}

interface DBConnectivityOptions {
	username: pulumi.Input<string>;
	password: pulumi.Input<string>;
	databaseName: string;
}

interface DBConnectivityArgs extends Partial<Omit<DBConnectivityOptions, 'username'>>, Pick<DBConnectivityOptions, 'username'> {
	/**
	 * Max connections at a single point to the database
	 */
	maxConnections?: number;

	tls?: {
		/**
		 * Add the SSL parameter to the connection string to require
		 * @default true
		 */
		requireSSLInURL?: boolean;
		/**
		 * Whether or not to require a client certificate to connect
		 * @default false
		 */
		requireClientCertificate?: boolean;
	};
}

export interface PostgresCloudSQLArgs {
	/**
	 * What to prefix the name of created resources with
	 */
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

	/**
	 * Whether or not to create the private services connection/peering between the VPC and Cloud SQL
	 * @default true
	 */
	createPeering?: boolean;

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
	 * Postgres concurrent connection limit / pool size
	 */
	connection_limit?: number
};

export class PostgresCloudSQL extends pulumi.ComponentResource {
	#prefix: string;
	#options: PostgresCloudSQLArgs;
	#usingReplicas: boolean;
	#vpcNetwork: VPCNetworkLike;

	readonly hosts: PerGCPRegion<SingleDBHost> = {};
	readonly primaryRegion: GCPRegion;
	readonly connectivity: DBConnectivityOptions;

	constructor(name: string, args: PostgresCloudSQLArgs, opts?: pulumi.ComponentResourceOptions) {
		super('Keeta:GCP:CloudSQL', name, args, opts);

		this.#prefix = args.prefix ?? name;
		this.#options = args;

		this.#vpcNetwork = args.vpcNetwork;
		this.primaryRegion = args.region;

		this.connectivity = {
			username: args.connectivity.username,
			password: args.connectivity?.password ?? this.#makePostgresPassword(),
			databaseName: args.connectivity.databaseName ?? 'main'
		};

		const replicaRegions = args.replication?.replicaRegions ?? [];
		this.#usingReplicas = replicaRegions.length > 0;

		const masterDependsOn = [];

		if (this.#options.createPeering !== false) {
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
				reservedPeeringRanges: [ privateIpAddress.name ]
			}, { parent: privateIpAddress });

			masterDependsOn.push(privateVpcConnection);
		}

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
			dependsOn: masterDependsOn
		});

		/**
		 * Loop over replica regions and create instances for each
		 */
		for (const region of replicaRegions) {
			/**
			 * Create the replica instance, with the master instance as the parent
			 */
			this.createPostgres(`${this.#prefix}-${region}-replica-instance`, region, masterDatabase, {
				parent: masterDatabase
			});
		}

		/**
		 * Create the database and user
		 * These will replicate to all instances from master
		 */
		new gcp.sql.Database(`${this.#prefix}-db`, {
			name: this.connectivity.databaseName,
			instance: masterDatabase.name,
			deletionPolicy: 'ABANDON'
		}, { parent: masterDatabase, protect: args.deletionProtection });

		new gcp.sql.User(`${this.#prefix}-db-user`, {
			instance: masterDatabase.name,
			name: this.connectivity.username,
			password: this.connectivity.password,
			deletionPolicy: 'ABANDON'
		}, { parent: masterDatabase });
	}

	/**
	 * Create a random string to be used as the postgres password
	 */
	#makePostgresPassword() {
		return new random.RandomString(`${this.#prefix}-postgres-password`, {
			length: 24,
			special: false,
			number: true
		}, { parent: this }).result;
	}

	createPostgres(name: string, region: GCPRegion, masterInstance?: gcp.sql.DatabaseInstance, options?: pulumi.ComponentResourceOptions) {
		if (this.hosts[region]) {
			throw new Error(`Region ${region} already exists in the list of hosts`);
		}

		let backupConfiguration: NonNullable<pulumi.Unwrap<ConstructorParameters<typeof gcp.sql.DatabaseInstance>[1]['settings']>>['backupConfiguration'];

		// We can only add backups to the primary region
		if (region === this.primaryRegion) {
			const backupOptions = this.#options.backups;

			if (backupOptions !== undefined) {
				backupConfiguration = {
					enabled: true,
					pointInTimeRecoveryEnabled: backupOptions.pointInTimeRecovery,
					startTime: backupOptions.startTime,
					transactionLogRetentionDays: backupOptions.retentionSettings?.transactionLogRetentionDays
				};

				if (backupOptions.retentionSettings?.retainCount !== undefined) {
					backupConfiguration.backupRetentionSettings = {
						retainedBackups: backupOptions.retentionSettings?.retainCount
					};
				}
			}

			if (this.#usingReplicas && !backupConfiguration?.pointInTimeRecoveryEnabled) {
				throw new Error('Point-in-time recovery must be enabled for backups when using replicas');
			}
		}

		let availabilityType = 'ZONAL';
		if (this.#options.replication?.multiZone) {
			availabilityType = 'REGIONAL';
		} else if (this.#usingReplicas) {
			throw new Error('Multi-zone (per region) must be enabled when using replicas');
		}

		const databaseFlags = [];
		if (this.#options.connectivity.maxConnections !== undefined) {
			databaseFlags.push({
				name: 'max_connections',
				value: String(this.#options.connectivity.maxConnections)
			});
		}

		const deletionProtection = this.#options.deletionProtection;

		const instance = new gcp.sql.DatabaseInstance(name, {
			region: region,
			databaseVersion: 'POSTGRES_14',
			deletionProtection: deletionProtection,
			masterInstanceName: masterInstance?.name,
			settings: {
				availabilityType: availabilityType,
				tier: this.#options.tier,
				ipConfiguration: {
					ipv4Enabled: false,
					privateNetwork: this.#vpcNetwork.id,
					requireSsl: this.#options.connectivity.tls?.requireClientCertificate
				},
				databaseFlags: databaseFlags,
				backupConfiguration: backupConfiguration
			}
		}, { protect: deletionProtection, ...options });

		this.hosts[region] = {
			host: instance.firstIpAddress,
			port: pulumi.output('5432'),
			caTlsCertificate: instance.serverCaCerts[0].cert,
			connectionName: instance.connectionName
		};

		return instance;
	}

	getHost(region: GCPRegion) {
		const host = this.hosts[this.primaryRegion];

		if (!host) {
			throw new Error(`Host does not exist: ${region}`);
		}

		return host;
	}

	getHostCIDR(region: GCPRegion) {
		const { host } = this.getHost(region);
		return pulumi.interpolate`${host}/32`;
	}

	getPrimaryHostCIDR() {
		return this.getHostCIDR(this.primaryRegion);
	}

	getPrimaryHost() {
		return this.getHost(this.primaryRegion);
	}

	getPrimaryHostURL(additionalParams?: pulumi.Input<PostgresURLParams>) {
		const selectedHost = this.getHost(this.primaryRegion);

		const combined = pulumi.all([selectedHost, this.connectivity, additionalParams]).apply(([selected, connectivity, resolvedParams]) => {
			const { host, port } = selected;
			const { username, password, databaseName } = connectivity;
			const url = new URL(`postgres://${username}:${password}@${host}:${port}/${databaseName}`);

			// Default to requiring SSL, unless explicitly set to false
			let sslMode = 'require';
			if (this.#options.connectivity.tls?.requireSSLInURL === false) {
				sslMode = 'prefer';
			} else {
				url.searchParams.set('sslaccept', 'strict');
			}

			url.searchParams.set('sslmode', sslMode);

			// Add any additional params
			// These will override any existing params with the same name
			for (const [key, value] of Object.entries(resolvedParams ?? {})) {
				if (value === undefined) {
					url.searchParams.delete(key);
					continue;
				}

				url.searchParams.set(key, String(value));
			}

			return url.toString();
		});

		return pulumi.secret(combined);
	}
}
