import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import * as path from 'node:path';
import { gcp as gcpComponents } from '@keetanetwork/pulumi-components';

const gcpProject = gcp.config.project ?? process.env.GOOGLE_PROJECT ?? process.env.GCLOUD_PROJECT;
if (!gcpProject) {
	throw new Error('GCP project not configured');
}

const name = `tf-static-${pulumi.getStack()}`.substring(0, 25);

// === Static Web App ===
export const staticApp = new gcpComponents.apps.StaticWebApp(name, {
	staticFilesPath: path.join(__dirname, 'static'),
	bucketConfig: { location: 'US' },
	cacheControl: {
		indexTTL: 10,
		assetsTTL: 86400,
		defaultTTL: 300
	},
	cdn: { enabled: true }
});

export const staticAppCDNOverride = new gcpComponents.apps.StaticWebApp(`tf-static-cdn-${pulumi.getStack()}`.substring(0, 25), {
	staticFilesPath: path.join(__dirname, 'static'),
	bucketConfig: { location: 'US' },
	cdn: {
		enabled: true,
		compressionMode: 'DISABLED',
		cdnPolicy: { cacheMode: 'FORCE_CACHE_ALL', defaultTtl: 120 }
	}
});
