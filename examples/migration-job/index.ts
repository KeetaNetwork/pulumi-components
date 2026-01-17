import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { gcp as gcpComponents } from '@keetanetwork/pulumi-components';

/**
 * Example: Standalone Migration Job
 *
 * This example tests the MigrationJob component which runs database migrations
 * against an existing Cloud SQL database.
 *
 * It creates:
 * 1. A Cloud SQL PostgreSQL database
 * 2. VPC networking for Cloud SQL connectivity
 * 3. A migration job that creates tables and inserts test data
 *
 * The migration runs actual SQL using psql and verifies the data was inserted.
 *
 * Run with:
 *   pulumi stack init test
 *   pulumi up
 *
 * Clean up with:
 *   pulumi destroy
 *   pulumi stack rm test
 */

// Auto-detect GCP project
const gcpProject = gcp.config.project ?? process.env.GOOGLE_PROJECT ?? process.env.GCLOUD_PROJECT;
if (!gcpProject) {
	throw new Error(
		'GCP project not configured. Set via:\n' +
		'  - gcloud config set project YOUR_PROJECT_ID\n' +
		'  - export GOOGLE_PROJECT=YOUR_PROJECT_ID\n' +
		'  - pulumi config set gcp:project YOUR_PROJECT_ID'
	);
}

const region: gcpComponents.constants.GCPRegion = 'us-central1';
const stack = pulumi.getStack();
// Keep name short - VPC connector has 25 char limit
const name = `mj-${stack}`.substring(0, 20);

// === Create VPC for Cloud SQL connectivity ===
const vpc = new gcp.compute.Network(`${name}-vpc`, {
	description: `[${name}] VPC network for migration test`,
	autoCreateSubnetworks: false
});

const subnet = new gcp.compute.Subnetwork(`${name}-subnet`, {
	description: `[${name}] Subnet`,
	network: vpc.selfLink,
	region: region,
	ipCidrRange: '10.0.0.0/24',
	privateIpGoogleAccess: true
}, { parent: vpc });

// VPC connector for Cloud Run Job to access Cloud SQL
const connectorName = `${name}-vpc`.substring(0, 25);
const vpcConnector = new gcp.vpcaccess.Connector(`${name}-vpc-connector`, {
	name: connectorName,
	ipCidrRange: '10.8.0.0/28',
	network: vpc.selfLink,
	region: region,
	minInstances: 2,
	maxInstances: 3
}, { parent: subnet });

// Private IP allocation for Cloud SQL
const privateIpAlloc = new gcp.compute.GlobalAddress(`${name}-private-ip`, {
	purpose: 'VPC_PEERING',
	addressType: 'INTERNAL',
	prefixLength: 16,
	network: vpc.selfLink
}, { parent: vpc });

// Service networking connection for Cloud SQL
const svcNetworkingConnection = new gcp.servicenetworking.Connection(`${name}-svc-networking`, {
	network: vpc.selfLink,
	service: 'servicenetworking.googleapis.com',
	reservedPeeringRanges: [privateIpAlloc.name],
	deletionPolicy: 'ABANDON'
});

// === Create Cloud SQL Database ===
const db = new gcpComponents.sql.PostgresCloudSQL(`${name}-db`, {
	region: region,
	tier: 'db-f1-micro',
	deletionProtection: false,
	vpcNetwork: vpc,
	insightsConfig: {
		queryInsightsEnabled: false
	},
	flags: {
		max_connections: 100
	}
}, {
	dependsOn: [svcNetworkingConnection]
});

// === Run Migration Job ===
// This creates tables and inserts test data using actual SQL
const migration = new gcpComponents.migration.MigrationJob(`${name}-migration`, {
	gcp: { project: gcpProject },
	region: region,

	database: {
		instance: db
	},

	// Use postgres image which has psql
	image: 'postgres:15-alpine',

	// Run actual SQL migration
	command: ['/bin/sh', '-c'],
	args: [
		`
		echo "=== Starting Migration ===" &&
		echo "Database: $PGDATABASE" &&
		echo "Host: $PGHOST" &&

		psql -v ON_ERROR_STOP=1 <<-EOSQL
			-- Create schema_migrations table to track migrations
			CREATE TABLE IF NOT EXISTS schema_migrations (
				version VARCHAR(255) PRIMARY KEY,
				applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				description TEXT
			);

			-- Insert migration record
			INSERT INTO schema_migrations (version, description)
			VALUES ('001', 'Initial schema setup')
			ON CONFLICT (version) DO NOTHING;

			-- Create a test table
			CREATE TABLE IF NOT EXISTS test_data (
				id SERIAL PRIMARY KEY,
				name VARCHAR(255) NOT NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			);

			-- Insert test data
			INSERT INTO test_data (name) VALUES ('migration-test-record-1');
			INSERT INTO test_data (name) VALUES ('migration-test-record-2');

			-- Verify the migration - FAIL if data is not correct
			DO \$\$
			DECLARE
				migration_count INTEGER;
				data_count INTEGER;
			BEGIN
				SELECT COUNT(*) INTO migration_count FROM schema_migrations WHERE version = '001';
				SELECT COUNT(*) INTO data_count FROM test_data WHERE name LIKE 'migration-test-record-%';

				IF migration_count = 0 THEN
					RAISE EXCEPTION 'VERIFICATION FAILED: schema_migrations record not found';
				END IF;

				IF data_count < 2 THEN
					RAISE EXCEPTION 'VERIFICATION FAILED: expected at least 2 test_data records, found %', data_count;
				END IF;

				RAISE NOTICE 'VERIFICATION PASSED: migration_count=%, data_count=%', migration_count, data_count;
			END \$\$;
		EOSQL

		echo "=== Migration Complete ==="
		`
	],

	vpc: {
		connector: vpcConnector
	},

	cpuLimit: 1,
	memoryLimit: 512,
	taskTimeout: 120,

	// Trigger re-run when this changes
	trigger: 'v1'
}, {
	dependsOn: [db, vpcConnector]
});

// === Exports for verification ===
export const project = gcpProject;

// Database outputs
export const databaseConnectionName = db.hosts[region]?.connectionName;
export const databaseName = db.databaseName;

// Migration outputs
export const migrationJobName = migration.job.name;
export const migrationStatus = migration.status;
export const migrationLogUri = migration.logUri;

// VPC outputs
export const vpcName = vpc.name;
export const subnetName = subnet.name;
export const vpcConnectorName = vpcConnector.name;
