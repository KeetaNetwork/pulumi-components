import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { gcp as gcpComponents } from '@keetanetwork/pulumi-components';

/**
 * Example: Cloud Run Service - Full Configuration Test
 *
 * Tests CloudRunService configuration options.
 * Auto-detects GCP project from gcloud CLI or environment variables.
 *
 * Run with:
 *   npm install
 *   pulumi stack init test
 *   pulumi up
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
const name = `tf-${stack}`;

const backend = new gcpComponents.apps.CloudRunService(name, {
	// === GCP Configuration ===
	gcp: {
		project: gcpProject
	},

	// === Region ===
	region: region,

	// === Image Configuration ===
	image: {
		// Using pre-built image (alternative: use build config for source builds)
		uri: 'gcr.io/cloudrun/hello'
	},

	// === Environment Variables ===
	environment: {
		// Plain text environment variables
		NODE_ENV: 'production',
		EXAMPLE_VAR: 'test-value'
	},

	// === Database Configuration ===
	// Presence of this object enables database creation
	database: {
		tier: 'db-f1-micro',
		flags: {
			'max_connections': 100
		},
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

	// === VPC Configuration ===
	vpc: {
		connectorCIDR: '10.8.0.0/28',
		subnetCIDR: '10.0.0.0/24',
		// ABANDON for easier cleanup in tests
		servicePeeringDeletionPolicy: 'ABANDON'
	},

	// === Service Configuration ===
	service: {
		cpuLimit: 1,
		memoryLimit: 512,
		grantIAMRoles: true,
		annotations: {
			'custom-annotation': 'test-value'
		}
	},

	// === MIG Worker Configuration ===
	mig: {
		enabled: true,
		instanceCount: 1,
		machineType: 'e2-micro',
		enableSSH: true,
		tags: ['test-mig'],
		allocateExternalIP: false,
		environmentOverrides: {
			WORKER_MODE: 'true'
		}
	}
});

// === Exports for Verification ===

// Basic info
export const project = gcpProject;
export const regionOutput = region;

// Service outputs
export const serviceUrl = backend.service.statuses.apply(function(s) {
	return(s[0]?.url);
});
export const serviceName = backend.service.name;
export const backendServiceId = backend.backendService.id;

// Service account
export const serviceAccountEmail = backend.serviceAccount && 'email' in backend.serviceAccount
	? backend.serviceAccount.email
	: undefined;

// Database outputs
export const databaseConnectionName = backend.database?.hosts[region]?.connectionName;

// VPC outputs
export const vpcName = backend.vpc?.name;
export const subnetName = backend.subnet?.name;
export const vpcConnectorName = backend.vpcConnector?.name;

// MIG outputs
export const migInstanceGroupId = backend.mig?.instanceGroupManager.id;
