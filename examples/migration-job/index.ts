import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { gcp as gcpComponents } from '@keetanetwork/pulumi-components';

const gcpProject = gcp.config.project ?? process.env.GOOGLE_PROJECT ?? process.env.GCLOUD_PROJECT;
if (!gcpProject) {
	throw new Error('GCP project not configured');
}

const region: gcpComponents.constants.GCPRegion = 'us-central1';
const stack = pulumi.getStack();
const name = `mj-${stack}`.substring(0, 20);

// === VPC for Cloud SQL connectivity ===
const vpc = new gcp.compute.Network(`${name}-vpc`, {
	description: `[${name}] VPC`,
	autoCreateSubnetworks: false
});

const subnet = new gcp.compute.Subnetwork(`${name}-subnet`, {
	description: `[${name}] Subnet`,
	network: vpc.selfLink,
	region: region,
	ipCidrRange: '10.0.0.0/24',
	privateIpGoogleAccess: true
}, { parent: vpc });

const vpcConnector = new gcp.vpcaccess.Connector(`${name}-vpc-connector`, {
	name: `${name}-vpc`.substring(0, 25),
	ipCidrRange: '10.8.0.0/28',
	network: vpc.selfLink,
	region: region,
	minInstances: 2,
	maxInstances: 3
}, { parent: subnet });

const privateIpAlloc = new gcp.compute.GlobalAddress(`${name}-private-ip`, {
	purpose: 'VPC_PEERING',
	addressType: 'INTERNAL',
	prefixLength: 16,
	network: vpc.selfLink
}, { parent: vpc });

const svcNetworkingConnection = new gcp.servicenetworking.Connection(`${name}-svc-networking`, {
	network: vpc.selfLink,
	service: 'servicenetworking.googleapis.com',
	reservedPeeringRanges: [privateIpAlloc.name],
	deletionPolicy: 'ABANDON' // Easier cleanup in tests
});

// === Cloud SQL Database ===
const db = new gcpComponents.sql.PostgresCloudSQL(`${name}-db`, {
	region: region,
	tier: 'db-f1-micro',
	deletionProtection: false,
	vpcNetwork: vpc,
	insightsConfig: { queryInsightsEnabled: false },
	flags: { max_connections: 100 }
}, { dependsOn: [svcNetworkingConnection] });

// === Migration Job ===
// Creates tables and verifies data using psql
const migration = new gcpComponents.migration.MigrationJob(`${name}-migration`, {
	gcp: { project: gcpProject },
	region: region,
	database: { instance: db },
	image: 'postgres:15-alpine',
	command: ['/bin/sh', '-c'],
	args: [`
		psql -v ON_ERROR_STOP=1 <<-EOSQL
			CREATE TABLE IF NOT EXISTS schema_migrations (
				version VARCHAR(255) PRIMARY KEY,
				applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				description TEXT
			);
			INSERT INTO schema_migrations (version, description)
			VALUES ('001', 'Initial schema setup')
			ON CONFLICT (version) DO NOTHING;

			CREATE TABLE IF NOT EXISTS test_data (
				id SERIAL PRIMARY KEY,
				name VARCHAR(255) NOT NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			);
			INSERT INTO test_data (name) VALUES ('migration-test-record-1');
			INSERT INTO test_data (name) VALUES ('migration-test-record-2');

			DO \$\$
			DECLARE
				migration_count INTEGER;
				data_count INTEGER;
			BEGIN
				SELECT COUNT(*) INTO migration_count FROM schema_migrations WHERE version = '001';
				SELECT COUNT(*) INTO data_count FROM test_data WHERE name LIKE 'migration-test-record-%';
				IF migration_count = 0 THEN
					RAISE EXCEPTION 'schema_migrations record not found';
				END IF;
				IF data_count < 2 THEN
					RAISE EXCEPTION 'expected at least 2 test_data records, found %', data_count;
				END IF;
			END \$\$;
		EOSQL
	`],
	vpc: { connector: vpcConnector },
	cpuLimit: 1,
	memoryLimit: 512,
	taskTimeout: 120,
	trigger: 'v1'
}, { dependsOn: [db, vpcConnector] });

// === Outputs ===
export const project = gcpProject;

// Database
export const databaseConnectionName = db.hosts[region]?.connectionName;
export const databaseName = db.databaseName;

// Migration
export const migrationJobName = migration.job.name;
export const migrationStatus = migration.status;
export const migrationLogUri = migration.logUri;

// VPC
export const vpcName = vpc.name;
export const subnetName = subnet.name;
export const vpcConnectorName = vpcConnector.name;
