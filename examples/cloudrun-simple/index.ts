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

export const backend = new gcpComponents.apps.CloudRunService(name, {
	gcp: { project: gcpProject },
	region: region,
	image: { uri: 'gcr.io/cloudrun/hello' },

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
		grantIAMRoles: true
	}
});

// === Outputs ===
// Note: Errors when trying to get the service URL from service
export const serviceUrl = backend.service.statuses.apply(function(s) { return(s[0]?.url); });
