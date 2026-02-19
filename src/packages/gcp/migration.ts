import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import type { GCPCommonOptions } from './common';
import type { GCPRegion } from './constants';
import type { PostgresCloudSQL } from './sql';
import { CloudRunJobExecution } from './cloudrun-job';
import { EnvManager } from './cloudrun';
import type { EnvironmentVariables } from './cloudrun';
import { buildDatabaseEnvVars } from './database-env';
import { generateName } from '../../utils';

/**
 * Database connection from an existing PostgresCloudSQL instance
 */
interface DatabaseInstanceConfig {
	instance: PostgresCloudSQL;
	host?: never;
	username?: never;
	password?: never;
	databaseName?: never;
}

/**
 * Database connection from explicit credentials
 */
interface DatabaseCredentialsConfig {
	instance?: never;
	host: pulumi.Input<string>;
	caCertificate: pulumi.Input<string>;
	username: pulumi.Input<string>;
	password: pulumi.Input<string>;
	databaseName: pulumi.Input<string>;
}

/**
 * Configuration for the MigrationJob component
 */
export interface MigrationJobArgs {
	/**
	 * GCP project and common options
	 */
	gcp: GCPCommonOptions;

	/**
	 * Region to deploy to
	 */
	region: GCPRegion;

	/**
	 * Database connection - either an existing PostgresCloudSQL instance or explicit credentials
	 */
	database: DatabaseInstanceConfig | DatabaseCredentialsConfig;

	/**
	 * Container image to use for migrations (e.g., 'postgres:15-alpine')
	 */
	image: pulumi.Input<string>;

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
	 * Optional VPC connector for private IP access to Cloud SQL
	 */
	vpc?: {
		connector: gcp.vpcaccess.Connector;
	};

	/**
	 * Optional service account to use (creates one if not provided)
	 */
	serviceAccount?: gcp.serviceaccount.Account | Pick<gcp.serviceaccount.Account, 'email'>;

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

	/**
	 * Additional environment variables
	 */
	environment?: { [key: string]: pulumi.Input<string> };

	/**
	 * Trigger value - when this changes, the migration job re-runs
	 * Typically set to image digest or a hash of migration files
	 * If not provided, uses the image URI
	 */
	trigger?: pulumi.Input<string>;
}

/**
 * MigrationJob Component
 *
 * Runs database migrations against an existing Cloud SQL database using a Cloud Run Job.
 *
 * Features:
 * - Works with existing PostgresCloudSQL instances or explicit credentials
 * - Auto-injects MC_PSQL_DB_* vars for database connection
 * - Uses Cloud SQL volume mount for secure connection
 * - Re-runs when trigger value changes (e.g., new image)
 */
export class MigrationJob extends pulumi.ComponentResource {
	readonly job: gcp.cloudrunv2.Job;
	readonly execution: CloudRunJobExecution;
	readonly status: pulumi.Output<string>;
	readonly logUri: pulumi.Output<string | null>;
	readonly serviceAccount: gcp.serviceaccount.Account | Pick<gcp.serviceaccount.Account, 'email'>;

	constructor(name: string, args: MigrationJobArgs, opts?: pulumi.ComponentResourceOptions) {
		super('Keeta:GCP:MigrationJob', name, args, opts);

		// Extract database connection info
		let dbHost: pulumi.Input<string>;
		let username: pulumi.Input<string>;
		let password: pulumi.Input<string>;
		let databaseName: pulumi.Input<string>;
		let caCertificate: pulumi.Input<string>;

		if ('instance' in args.database && args.database.instance) {
			const db = args.database.instance;
			const hostInfo = db.hosts[args.region] ?? db.hosts[db.primaryRegion];
			if (!hostInfo) {
				throw(new Error(`No database host found for region ${args.region} or primary region ${db.primaryRegion}`));
			}

			dbHost = hostInfo.host;
			caCertificate = hostInfo.caCertificate;
			username = db.username;
			password = db.password;
			databaseName = db.databaseName;
		} else {
			dbHost = args.database.host;
			caCertificate = args.database.caCertificate;
			username = args.database.username;
			password = args.database.password;
			databaseName = args.database.databaseName;
		}

		// Create or use service account
		let serviceAccount: gcp.serviceaccount.Account | Pick<gcp.serviceaccount.Account, 'email'>;
		if (args.serviceAccount) {
			serviceAccount = args.serviceAccount;
		} else {
			const accountId = generateName(name, 'sa', 30);
			serviceAccount = new gcp.serviceaccount.Account(`${name}-sa`, {
				description: `[${name}] Migration job service account`,
				accountId
			}, { parent: this });
		}
		this.serviceAccount = serviceAccount;

		// Grant Cloud SQL Client role to service account
		new gcp.projects.IAMMember(`${name}-cloudsql-client`, {
			project: args.gcp.project,
			role: 'roles/cloudsql.client',
			member: pulumi.interpolate`serviceAccount:${serviceAccount.email}`
		}, { parent: this });

		// Build environment variables
		const variables: EnvironmentVariables = {
			...buildDatabaseEnvVars({
				host: dbHost,
				username,
				password,
				databaseName,
				caCertificate
			}),
			...args.environment
		};

		const envManager = new EnvManager(`${name}-env`, {
			serviceAccount: pulumi.interpolate`serviceAccount:${serviceAccount.email}`,
			secretRegionName: args.region,
			variables
		}, { parent: this });

		// Configure VPC access if connector is provided
		let vpcAccess: { connector: pulumi.Output<string>; egress: string } | undefined;
		if (args.vpc?.connector) {
			vpcAccess = { connector: args.vpc.connector.id, egress: 'PRIVATE_RANGES_ONLY' };
		}

		// Create Cloud Run Job (connects to Cloud SQL via VPC private IP)
		this.job = new gcp.cloudrunv2.Job(`${name}-job`, {
			location: args.region,
			deletionProtection: false,
			template: {
				template: {
					serviceAccount: serviceAccount.email,
					vpcAccess,
					containers: [{
						image: args.image,
						commands: args.container?.entrypoint,
						args: args.container?.args,
						envs: envManager.cloudRunJobVariableOutput,
						resources: {
							limits: {
								cpu: String(args.cpuLimit ?? 1),
								memory: `${args.memoryLimit ?? 512}Mi`
							}
						}
					}],
					maxRetries: 1,
					timeout: `${args.taskTimeout ?? 600}s`
				}
			}
		}, { parent: this });

		// Execute the job and wait for completion
		const trigger = args.trigger ?? args.image;
		this.execution = new CloudRunJobExecution(`${name}-exec`, {
			jobName: this.job.name,
			projectId: args.gcp.project,
			region: args.region,
			trigger: pulumi.output(trigger).apply(function(t) { return(t); })
		}, {
			parent: this.job,
			dependsOn: [this.job]
		});

		this.status = this.execution.status;
		this.logUri = this.execution.logUri;

		this.registerOutputs({
			jobName: this.job.name,
			status: this.status,
			logUri: this.logUri
		});
	}
}

export default MigrationJob;
