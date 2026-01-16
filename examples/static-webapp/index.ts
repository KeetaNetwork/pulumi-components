import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import * as path from 'path';
import { gcp as gcpComponents } from '@keetanetwork/pulumi-components';

// Auto-detect GCP project from environment
const gcpProject = gcp.config.project ?? process.env.GOOGLE_PROJECT ?? process.env.GCLOUD_PROJECT;

if (!gcpProject) {
	throw new Error('GCP project not configured. Set GOOGLE_PROJECT env var or configure gcp:project');
}

const name = `tf-static-${pulumi.getStack()}`.substring(0, 25);

// Deploy static web app to GCS bucket
// Without loadBalancer config, this only creates the bucket and backend bucket
// (no global load balancer, SSL, or DNS)
const staticApp = new gcpComponents.apps.StaticWebApp(name, {
	staticFilesPath: path.join(__dirname, 'static'),

	// Optional: customize bucket config
	bucketConfig: {
		location: 'US'
	},

	// Optional: customize cache TTLs
	cacheControl: {
		indexTTL: 10,       // 10 seconds for index.html
		assetsTTL: 86400,   // 1 day for assets
		defaultTTL: 300     // 5 minutes for other files
	}
});

// Export outputs for testing
export const bucketName = staticApp.bucket.name;
export const bucketUrl = pulumi.interpolate`https://storage.googleapis.com/${staticApp.bucket.name}/index.html`;
export const backendBucketName = staticApp.backendBucket.name;
