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
export const vpc = new gcp.compute.Network(`${name}-vpc`, {
	description: `[${name}] VPC`,
	autoCreateSubnetworks: false
});

export const subnet = new gcp.compute.Subnetwork(`${name}-subnet`, {
	description: `[${name}] Subnet`,
	network: vpc.selfLink,
	region: region,
	ipCidrRange: '10.0.0.0/24',
	privateIpGoogleAccess: true
}, { parent: vpc });

export const vpcConnector = new gcp.vpcaccess.Connector(`${name}-vpc-connector`, {
	name: `${name}-vpc`.substring(0, 25),
	ipCidrRange: '10.8.0.0/28',
	network: vpc.selfLink,
	region: region,
	minInstances: 2,
	maxInstances: 3
}, { parent: subnet });

export const privateIpAlloc = new gcp.compute.GlobalAddress(`${name}-private-ip`, {
	purpose: 'VPC_PEERING',
	addressType: 'INTERNAL',
	prefixLength: 16,
	network: vpc.selfLink
}, { parent: vpc });

export const svcNetworkingConnection = new gcp.servicenetworking.Connection(`${name}-svc-networking`, {
	network: vpc.selfLink,
	service: 'servicenetworking.googleapis.com',
	reservedPeeringRanges: [privateIpAlloc.name],
	deletionPolicy: 'ABANDON' // Easier cleanup in tests
});

// === Cloud SQL Database ===
export const db = new gcpComponents.sql.PostgresCloudSQL(`${name}-db`, {
	region: region,
	tier: 'db-f1-micro',
	deletionProtection: false,
	vpcNetwork: vpc,
	insightsConfig: { queryInsightsEnabled: false },
	flags: { max_connections: 100 }
}, { dependsOn: [svcNetworkingConnection] });

// === Migration Job ===
export const migration = new gcpComponents.migration.MigrationJob(`${name}-migration`, {
	gcp: { project: gcpProject },
	region: region,
	database: { instance: db },
	image: 'postgres:15-alpine',
	command: ['/bin/sh', '-c'],
	args: [
		'psql "$MC_PSQL_DB_URL" -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS test_table (id SERIAL PRIMARY KEY, name TEXT);" && ' +
		'psql "$MC_PSQL_DB_URL" -v ON_ERROR_STOP=1 -c "INSERT INTO test_table (name) VALUES (\'test\');" && ' +
		'psql "$MC_PSQL_DB_URL" -v ON_ERROR_STOP=1 -c "SELECT COUNT(*) FROM test_table;"'
	],
	vpc: { connector: vpcConnector },
	cpuLimit: 1,
	memoryLimit: 512,
	taskTimeout: 120,
	trigger: 'v3'
}, { dependsOn: [db, vpcConnector] });
