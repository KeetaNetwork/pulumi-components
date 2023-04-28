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
	 * CA Certificate for the database (in PEM format)
	 */
	caCertificate: pulumi.Output<string>;
}

interface DBFlags {
	/**
	 * Max connections at a single point to the database
	 */
	max_connections?: number;

	/**
	 * Causes checkpoints and restart-points to be logged in the server log.
	 */
	log_checkpoints?: boolean;

	/**
	 * Causes each attempted connection to the server to be logged, as well as successful completion of both client authentication (if necessary) and authorization
	 */
	log_connections?: boolean;

	/**
	 * Causes session terminations to be logged.
	 */
	log_disconnections?: boolean;

	/**
	 * Causes the duration of every completed statement to be logged.
	 */
	log_duration?: boolean;

	/**
	 * Controls whether a log message is produced when a session waits longer than deadlock_timeout to acquire a lock
	 */
	log_lock_waits?: boolean;

	/**
	 * Controls logging of temporary file names and sizes.
	 */
	log_temp_files?: number;
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
	 * The region to deploy cloud sql and its dependencies to, if multiple
	 * regions are specified in @see replication.replicaRegions, this will
	 * be the region that the master instance is created in
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
	 * @default false
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
	 * Flags to pass to the database
	 */
	flags?: DBFlags;

	/**
	 * TLS Options
	 */
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

	/**
	 * Username to create for the database
	 */
	username?: pulumi.Input<string>;

	/**
	 * Password to use when connecting to the database
	 */
	password?: pulumi.Input<string>;

	/**
	 * Name of the datbase to create
	 */
	databaseName?: pulumi.Input<string>;
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

	/* XXX:TODO: Should add the rest of the args here as well... */
	/**
	 * Username to use when connecting to the database
	 */
	readonly username: pulumi.Output<string>;

	/**
	 * Password to use when connecting to the database
	 */
	readonly password: pulumi.Output<string>;

	/**
	 * Name of the database created
	 */
	readonly databaseName: pulumi.Output<string>;

	/**
	 * IP of the master database
	 */
	readonly masterHost: pulumi.Output<string>;

	/**
	 * Port of the master database
	 */
	readonly masterPort: pulumi.Output<string>;

	constructor(name: string, args: PostgresCloudSQLArgs, opts?: pulumi.ComponentResourceOptions) {
		super('Keeta:GCP:PostgresCloudSQL', name, args, opts);

		this.#prefix = args.prefix ?? name;
		this.#options = args;

		this.#vpcNetwork = args.vpcNetwork;
		this.primaryRegion = args.region;

		const replicaRegions = args.replication?.replicaRegions ?? [];
		this.#usingReplicas = replicaRegions.length > 0;

		/**
		 * Ensure that the replica regions is sane
		 */
		if (replicaRegions.includes(this.primaryRegion)) {
			throw new Error('Primary region cannot be included in the list of regions (Postgres)');
		}

		/**
		 * A list of dependencies that must be created prior to creating the master instance
		 */
		const masterDependsOn = [];
		if (this.#options.createPeering) {
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
			const vpcConnection = new gcp.servicenetworking.Connection(`${this.#prefix}-postgres-vpc-connection`, {
				network: this.#vpcNetwork.id,
				service: 'servicenetworking.googleapis.com',
				reservedPeeringRanges: [ privateIpAddress.name ]
			}, { parent: privateIpAddress });

			masterDependsOn.push(vpcConnection);
		}

		/**
		 * Create the master database instance
		 * This will be created no matter what replication is set to
		 */
		const masterDatabase = this.createPostgres(`${this.#prefix}-master`, this.primaryRegion, undefined, {
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
			this.createPostgres(`${this.#prefix}-${region}-replica`, region, masterDatabase, {
				parent: masterDatabase
			});
		}

		/**
		 * Create the database and user
		 * These will replicate to all instances from master
		 */
		const db = new gcp.sql.Database(`${this.#prefix}-db`, {
			name: args.databaseName,
			instance: masterDatabase.name
		}, {
			parent: masterDatabase,
			protect: args.deletionProtection
		});
		this.databaseName = db.name;

		/**
		 * Use the user-defined password or generate one
		 */
		let password = args.password;
		if (password === undefined) {
			password = this.#makePostgresPassword();
		}

		const user = new gcp.sql.User(`${this.#prefix}-db-user`, {
			instance: masterDatabase.name,
			name: args.username,
			password: password
		}, {
			parent: masterDatabase
		});
		this.username = user.name;
		this.password = pulumi.secret(pulumi.output(password));

		this.masterHost = this.getPrimaryHostIP();
		this.masterPort = this.getPrimaryHost().port;
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

	private getBackupConfiguration(region: GCPRegion) {
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

		return(backupConfiguration);
	}

	createPostgres(name: string, region: GCPRegion, masterInstance?: gcp.sql.DatabaseInstance, options?: pulumi.ComponentResourceOptions) {
		if (this.hosts[region]) {
			throw new Error(`Region ${region} already exists in the list of hosts`);
		}

		const backupConfiguration = this.getBackupConfiguration(region);

		let availabilityType = 'ZONAL';
		if (this.#options.replication?.multiZone) {
			availabilityType = 'REGIONAL';
		} else if (this.#usingReplicas) {
			throw new Error('Multi-zone (per region) must be enabled when using replicas');
		}

		const databaseFlags = [];

		for (const [key, value] of Object.entries(this.#options.flags ?? {})) {
			if (value === undefined) {
				continue;
			}

			databaseFlags.push({
				name: key,
				value: String(value)
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
					// This is named badly on pulumi's side
					requireSsl: this.#options.tls?.requireClientCertificate
				},
				databaseFlags: databaseFlags,
				backupConfiguration: backupConfiguration
			}
		}, { protect: deletionProtection, ...options });

		this.hosts[region] = {
			host: instance.firstIpAddress,
			port: pulumi.output('5432'),
			caCertificate: instance.serverCaCerts[0].cert,
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

	getHostIP(region: GCPRegion) {
		const hostInfo = this.getHost(region);
		const host =  hostInfo.host;
		return(host);
	}

	getHostCIDR(region: GCPRegion) {
		const hostInfo = this.getHost(region);
		const host =  hostInfo.host;
		return(pulumi.interpolate`${host}/32`);
	}

	getPrimaryHost() {
		return(this.getHost(this.primaryRegion));
	}

	getPrimaryHostIP() {
		return(this.getHostIP(this.primaryRegion));
	}

	getPrimaryHostCIDR() {
		return(this.getHostCIDR(this.primaryRegion));
	}

	getPrimaryHostURL(additionalParams?: pulumi.Input<PostgresURLParams>) {
		const primaryDBInfoPromise = this.getHost(this.primaryRegion);

		const combined = pulumi.all([primaryDBInfoPromise, this.username, this.password, this.databaseName, additionalParams]).apply(([primaryDBInfo, username, password, databaseName, resolvedParams]) => {
			const { host, port } = primaryDBInfo;
			const url = new URL(`postgres://${username}:${password}@${host}:${port}/${databaseName}`);

			// Default to requiring SSL, unless explicitly set to false
			let sslMode = 'require';
			if (this.#options.tls?.requireSSLInURL === false) {
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

		return combined;
	}
}
