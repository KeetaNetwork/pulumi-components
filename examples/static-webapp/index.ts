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
export const staticApp = new gcpComponents.apps.StaticWebApp(name, {
	staticFilesPath: path.join(__dirname, 'static'),
	bucketConfig: { location: 'US' },
	cacheControl: {
		indexTTL: 10,
		assetsTTL: 86400,
		defaultTTL: 300
	}
});
