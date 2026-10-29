import { describe, it, expect, afterAll } from 'vitest';
import { deployStack, destroyStack, type StackOutputs } from '../helpers/pulumi';

describe('StaticWebApp', function() {
	const stackName = `test-${Date.now()}`;
	let outputs: StackOutputs | undefined;

	it('deploys and serves content', async function() {
		outputs = await deployStack('examples/static-webapp', stackName);

		// Verify component output exists
		expect(outputs.staticApp).toBeDefined();

		// Get bucket name from component's registered outputs
		const staticApp = outputs.staticApp as {
			bucket: { name: string };
			backendBucket: { enableCdn: boolean; compressionMode: string; cdnPolicy: { cacheMode: string } };
		};
		expect(staticApp.bucket?.name).toBeDefined();

		/* cdn: { enabled: true } turns on CDN with the defaults */
		expect(staticApp.backendBucket.enableCdn).toBe(true);
		expect(staticApp.backendBucket.compressionMode).toBe('AUTOMATIC');
		expect(staticApp.backendBucket.cdnPolicy.cacheMode).toBe('USE_ORIGIN_HEADERS');

		const staticAppCDNOverride = outputs.staticAppCDNOverride as {
			backendBucket: { enableCdn: boolean; compressionMode: string; cdnPolicy: { cacheMode: string; defaultTtl: number } };
		};
		expect(staticAppCDNOverride.backendBucket.enableCdn).toBe(true);
		expect(staticAppCDNOverride.backendBucket.compressionMode).toBe('DISABLED');
		expect(staticAppCDNOverride.backendBucket.cdnPolicy.cacheMode).toBe('FORCE_CACHE_ALL');
		expect(staticAppCDNOverride.backendBucket.cdnPolicy.defaultTtl).toBe(120);

		// Fetch the deployed content
		const bucketUrl = `https://storage.googleapis.com/${staticApp.bucket.name}/index.html`;
		const response = await fetch(bucketUrl);
		expect(response.ok).toBe(true);

		// Verify it's our HTML content
		const html = await response.text();
		expect(html).toContain('Static Web App');
		expect(html).toContain('Deployed successfully via Pulumi');
	}, 300_000); // 5 min timeout (simple GCS deployment)

	afterAll(async function() {
		await destroyStack('examples/static-webapp', stackName);
	}, 1_800_000); // 30 min timeout for destroy
});
