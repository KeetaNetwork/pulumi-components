import { describe, it, expect, afterAll } from 'vitest';
import { deployStack, destroyStack, type StackOutputs } from '../helpers/pulumi';

describe('StaticWebApp', function() {
	const stackName = `test-${Date.now()}`;
	let outputs: StackOutputs | undefined;
	let deploymentSucceeded = false;

	it('deploys and serves content', async function() {
		outputs = await deployStack('examples/static-webapp', stackName);
		deploymentSucceeded = true;

		// Verify component output exists
		expect(outputs.staticApp).toBeDefined();

		// Get bucket name from component's registered outputs
		const staticApp = outputs.staticApp as { bucket: { name: string } };
		expect(staticApp.bucket?.name).toBeDefined();

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
		// Only attempt cleanup if we have a stack to destroy
		if (deploymentSucceeded || outputs) {
			await destroyStack('examples/static-webapp', stackName);
		}
	}, 300_000); // 5 min timeout for destroy
});
