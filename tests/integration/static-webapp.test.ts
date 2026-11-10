import { describe, it, expect, afterAll } from 'vitest';
import { deployStack, destroyStack, testStackName, type StackOutputs } from '../helpers/pulumi';
import { expectRecord, expectString } from '../helpers/narrow';

describe('StaticWebApp', function() {
	const stackName = testStackName('sw');
	let outputs: StackOutputs | undefined;

	it('deploys and serves content', async function() {
		outputs = await deployStack('examples/static-webapp', stackName);

		// Verify component output exists
		expect(outputs.staticApp).toBeDefined();

		// Get bucket name from component's registered outputs
		const staticApp = expectRecord(outputs.staticApp, 'staticApp output');
		const bucketName = expectString(expectRecord(staticApp.bucket, 'staticApp bucket').name, 'staticApp bucket name');
		expect(bucketName).toBeDefined();

		/* cdn: { enabled: true } turns on CDN with the defaults */
		const backendBucket = expectRecord(staticApp.backendBucket, 'staticApp backendBucket');
		const cdnPolicy = expectRecord(backendBucket.cdnPolicy, 'staticApp cdnPolicy');
		expect(backendBucket.enableCdn).toBe(true);
		expect(backendBucket.compressionMode).toBe('AUTOMATIC');
		expect(cdnPolicy.cacheMode).toBe('USE_ORIGIN_HEADERS');

		const staticAppCDNOverride = expectRecord(outputs.staticAppCDNOverride, 'staticAppCDNOverride output');
		const overrideBackendBucket = expectRecord(staticAppCDNOverride.backendBucket, 'staticAppCDNOverride backendBucket');
		const overrideCDNPolicy = expectRecord(overrideBackendBucket.cdnPolicy, 'staticAppCDNOverride cdnPolicy');
		expect(overrideBackendBucket.enableCdn).toBe(true);
		expect(overrideBackendBucket.compressionMode).toBe('DISABLED');
		expect(overrideCDNPolicy.cacheMode).toBe('FORCE_CACHE_ALL');
		expect(overrideCDNPolicy.defaultTtl).toBe(120);

		// Fetch the deployed content
		const bucketUrl = `https://storage.googleapis.com/${bucketName}/index.html`;
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
