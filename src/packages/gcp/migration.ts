import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import type { GCPCommonOptions } from './common';
import type { GCPRegion } from './constants';
import type { PostgresCloudSQL } from './sql';
import { CloudRunJobExecution } from './cloudrun-job';
import { generateName } from '../../utils';

/**
 * Database connection from an existing PostgresCloudSQL instance
 */
interface DatabaseInstanceConfig {
	instance: PostgresCloudSQL;
	connectionName?: never;
	username?: never;
	password?: never;
	databaseName?: never;
}

/**
 * Database connection from explicit credentials
 */
interface DatabaseCredentialsConfig {
	instance?: never;
	connectionName: pulumi.Input<string>;
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
	 * Override container entrypoint
	 */
	command?: string[];

	/**
	 * Override container arguments
	 */
	args?: string[];

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
 * - Auto-injects PGUSER, PGPASSWORD, PGDATABASE, PGHOST, DATABASE_URL
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
		let connectionName: pulumi.Input<string>;
		let username: pulumi.Input<string>;
		let password: pulumi.Input<string>;
		let databaseName: pulumi.Input<string>;

		if ('instance' in args.database && args.database.instance) {
			const db = args.database.instance;
			connectionName = db.hosts[args.region]?.connectionName ?? db.hosts[db.primaryRegion]?.connectionName ?? '';
			username = db.username;
			password = db.password;
			databaseName = db.databaseName;
		} else {
			connectionName = args.database.connectionName;
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

		// Build environment variables
		const envVars: gcp.types.input.cloudrunv2.JobTemplateTemplateContainerEnv[] = [
			{ name: 'PGUSER', value: username },
			{ name: 'PGPASSWORD', value: password },
			{ name: 'PGDATABASE', value: databaseName },
			{ name: 'PGHOST', value: pulumi.interpolate`/cloudsql/${connectionName}` },
			{ name: 'PGPORT', value: '5432' },
			{
				name: 'DATABASE_URL',
				value: pulumi.interpolate`postgresql://${username}:${password}@/${databaseName}?host=/cloudsql/${connectionName}`
			}
		];

		// Add user-provided environment variables
		if (args.environment) {
			for (const [key, value] of Object.entries(args.environment)) {
				envVars.push({ name: key, value });
			}
		}

		// Cloud SQL volume mount
		const volumes: gcp.types.input.cloudrunv2.JobTemplateTemplateVolume[] = [{
			name: 'cloudsql',
			cloudSqlInstance: {
				instances: [connectionName]
			}
		}];

		const volumeMounts: gcp.types.input.cloudrunv2.JobTemplateTemplateContainerVolumeMount[] = [{
			name: 'cloudsql',
			mountPath: '/cloudsql'
		}];

		// Create Cloud Run Job
		this.job = new gcp.cloudrunv2.Job(`${name}-job`, {
			location: args.region,
			deletionProtection: false,
			template: {
				template: {
					serviceAccount: serviceAccount.email,
					vpcAccess: args.vpc?.connector ? {
						connector: args.vpc.connector.id,
						egress: 'PRIVATE_RANGES_ONLY'
					} : undefined,
					volumes,
					containers: [{
						image: args.image,
						commands: args.command,
						args: args.args,
						envs: envVars,
						resources: {
							limits: {
								cpu: String(args.cpuLimit ?? 1),
								memory: `${args.memoryLimit ?? 512}Mi`
							}
						},
						volumeMounts
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
			parent: this,
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
