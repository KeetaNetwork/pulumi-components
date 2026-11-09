import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { gcp as gcpComponents } from '@keetanetwork/pulumi-components';

const gcpProject = gcp.config.project ?? process.env.GOOGLE_PROJECT ?? process.env.GCLOUD_PROJECT;
if (!gcpProject) {
	throw new Error('GCP project not configured');
}

const region: gcpComponents.constants.GCPRegion = 'us-central1';
/*
 * GCP resource names derive from "name", and some GCP names allow few
 * characters. A short hash of the stack name keeps them short and unique for
 * every stack, whatever the length of the stack name.
 */
const stackId = createHash('sha256').update(pulumi.getStack()).digest('hex').substring(0, 8);
const name = `db-test-${stackId}`;
const config = new pulumi.Config();

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

	// A secret variable whose value the test changes, to roll the service onto a new secret version
	environment: {
		API_TOKEN: { value: config.get('apiToken') ?? 'initial', secret: true }
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

// The secret and the version that the service reads API_TOKEN from, for the test that changes the token
export const apiTokenReference = backend.service.template.apply(function(template) {
	const environment = template?.spec.containers[0]?.envs ?? [];
	const entry = environment.find(function(candidate) {
		return(candidate.name === 'API_TOKEN');
	});

	return(entry?.valueFrom?.secretKeyRef);
});
