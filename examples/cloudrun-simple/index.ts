import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { gcp as gcpComponents } from '@keetanetwork/pulumi-components';

const gcpProject = gcp.config.project ?? process.env.GOOGLE_PROJECT ?? process.env.GCLOUD_PROJECT;
if (!gcpProject) {
	throw new Error('GCP project not configured');
}

const region: gcpComponents.constants.GCPRegion = 'us-central1';
const stack = pulumi.getStack();
const name = `tf-${stack}`;

// === Cloud Run Service ===
const backend = new gcpComponents.apps.CloudRunService(name, {
	gcp: { project: gcpProject },
	region: region,
	image: { uri: 'gcr.io/cloudrun/hello' },

	// Environment
	environment: {
		NODE_ENV: 'production',
		EXAMPLE_VAR: 'test-value'
	},

	// Cloud SQL database
	database: {
		tier: 'db-f1-micro',
		flags: { 'max_connections': 100 },
		queryInsights: true,
		backups: {
			pointInTimeRecovery: true,
			startTime: '03:00',
			retentionSettings: {
				retainCount: 7,
				transactionLogRetentionDays: 3
			}
		}
	},

	// VPC for private connectivity
	vpc: {
		connectorCIDR: '10.8.0.0/28',
		subnetCIDR: '10.0.0.0/24',
		servicePeeringDeletionPolicy: 'ABANDON'
	},

	// Service limits
	service: {
		cpuLimit: 1,
		memoryLimit: 512,
		grantIAMRoles: true,
		annotations: { 'custom-annotation': 'test-value' }
	},

	// MIG worker for background tasks
	mig: {
		enabled: true,
		instanceCount: 1,
		machineType: 'e2-micro',
		enableSSH: true,
		tags: ['test-mig'],
		allocateExternalIP: false,
		environmentOverrides: { WORKER_MODE: 'true' }
	}
});

// === Outputs ===
export const project = gcpProject;
export const regionOutput = region;

// Service
export const serviceUrl = backend.service.statuses.apply(function(s) { return(s[0]?.url); });
export const serviceName = backend.service.name;
export const backendServiceId = backend.backendService.id;
export const serviceAccountEmail = backend.serviceAccount && 'email' in backend.serviceAccount
	? backend.serviceAccount.email
	: undefined;

// Database
export const databaseConnectionName = backend.database?.hosts[region]?.connectionName;

// VPC
export const vpcName = backend.vpc?.name;
export const subnetName = backend.subnet?.name;
export const vpcConnectorName = backend.vpcConnector?.name;

// MIG
export const migInstanceGroupId = backend.mig?.instanceGroupManager.id;
