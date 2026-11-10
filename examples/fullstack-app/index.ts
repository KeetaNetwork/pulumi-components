import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { gcp as gcpComponents } from '@keetanetwork/pulumi-components';

const gcpProject = gcp.config.project ?? process.env.GOOGLE_PROJECT ?? process.env.GCLOUD_PROJECT;
if (!gcpProject) {
	throw new Error('GCP project not configured');
}

const config = new pulumi.Config();
const domain = config.require('domain');
const dnsZoneId = config.get('dnsZoneId');

const region: gcpComponents.constants.GCPRegion = 'us-central1';
/*
 * GCP resource names derive from "name", and some GCP names allow few
 * characters. A short hash of the stack name keeps them short and unique for
 * every stack, whatever the length of the stack name.
 */
const stackId = createHash('sha256').update(pulumi.getStack()).digest('hex').substring(0, 8);
const name = `fs-test-${stackId}`;

const registry = new gcp.artifactregistry.Repository(`${name}-repo`, {
	location: region,
	repositoryId: `${name}-repo`.substring(0, 25),
	format: 'DOCKER'
});

const registryUrl = pulumi.interpolate`${region}-docker.pkg.dev/${gcpProject}/${registry.repositoryId}`;

export const app = new gcpComponents.apps.FullStackApp(name, {
	loadBalancer: {
		domain,
		dnsZoneId,
		ssl: {
			domains: [domain]
		}
	},
	frontend: {
		staticFilesPath: path.join(__dirname, 'static'),
		bucketConfig: { location: 'US' }
	},
	backend: {
		gcp: { project: gcpProject },
		region,
		image: {
			build: {
				directory: path.join(__dirname, 'app'),
				imageName: 'fs-test-app',
				registryUrl,
				remote: {}
			}
		},
		database: {
			tier: 'db-f1-micro'
		},
		vpc: {
			connectorCIDR: '10.8.0.0/28',
			subnetCIDR: '10.0.0.0/24',
			servicePeeringDeletionPolicy: 'ABANDON'
		},
		service: {
			cpuLimit: 1,
			memoryLimit: 512
		},
		migration: {
			enabled: true,
			container: {
				entrypoint: ['node', 'dist/migrate.js']
			}
		}
	},
	routing: {
		apiPrefix: '/api'
	}
});

export const serviceUrl = app.backend.service.statuses.apply(function(s) { return(s[0]?.url); });
export const ips = app.ips;

// The image that the service runs, pinned by the digest that Cloud Build reported
export const deployedImage = app.backend.service.template.apply(function(template) {
	return(template?.spec.containers[0]?.image);
});

// The status of the migration run, as the dynamic resource of the run reported it
export const migrationStatus = app.backend.migration?.status;
