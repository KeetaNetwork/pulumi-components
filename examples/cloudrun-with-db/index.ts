import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import * as path from 'path';
import { gcp as gcpComponents } from '@keetanetwork/pulumi-components';

const gcpProject = gcp.config.project ?? process.env.GOOGLE_PROJECT ?? process.env.GCLOUD_PROJECT;
if (!gcpProject) {
	throw new Error('GCP project not configured');
}

const region: gcpComponents.constants.GCPRegion = 'us-central1';
const stack = pulumi.getStack();
const name = `db-test-${stack}`.substring(0, 25);

// Artifact Registry for the test app image
const registry = new gcp.artifactregistry.Repository(`${name}-repo`, {
	location: region,
	repositoryId: `${name}-repo`.substring(0, 25),
	format: 'DOCKER'
});

const registryUrl = pulumi.interpolate`${region}-docker.pkg.dev/${gcpProject}/${registry.repositoryId}`;

// Cloud Run Service with database and custom app
export const backend = new gcpComponents.apps.CloudRunService(name, {
	gcp: { project: gcpProject },
	region: region,

	// Build custom app that tests DB connectivity
	image: {
		build: {
			directory: path.join(__dirname, 'app'),
			imageName: 'db-test-app',
			registryUrl: registryUrl
		}
	},

	// Cloud SQL database
	database: {
		tier: 'db-f1-micro'
	},

	// VPC for private connectivity
	vpc: {
		connectorCIDR: '10.8.0.0/28',
		subnetCIDR: '10.0.0.0/24',
		servicePeeringDeletionPolicy: 'ABANDON'
	},

	service: {
		cpuLimit: 1,
		memoryLimit: 512
	},

	// Run database migrations before starting the service
	migration: {
		enabled: true,
		container: {
			entrypoint: ['node', 'dist/migrate.js']
		}
	}
});

// Explicit output for test access
export const serviceUrl = backend.service.statuses.apply(function(s) { return(s[0]?.url); });
