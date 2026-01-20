import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import * as path from 'path';
import { gcp as gcpComponents } from '@keetanetwork/pulumi-components';

const gcpProject = gcp.config.project ?? process.env.GOOGLE_PROJECT ?? process.env.GCLOUD_PROJECT;
if (!gcpProject) {
	throw new Error('GCP project not configured');
}

const name = `tf-static-${pulumi.getStack()}`.substring(0, 25);

// === Static Web App ===
// Deploys files to GCS bucket with backend bucket for load balancer
const staticApp = new gcpComponents.apps.StaticWebApp(name, {
	staticFilesPath: path.join(__dirname, 'static'),
	bucketConfig: { location: 'US' },
	cacheControl: {
		indexTTL: 10,      // 10s for index.html
		assetsTTL: 86400,  // 1 day for assets
		defaultTTL: 300    // 5 min default
	}
});

// === Outputs ===
export const bucketName = staticApp.bucket.name;
export const bucketUrl = pulumi.interpolate`https://storage.googleapis.com/${staticApp.bucket.name}/index.html`;
export const backendBucketName = staticApp.backendBucket.name;
