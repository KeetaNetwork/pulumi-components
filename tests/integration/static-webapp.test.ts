import { describe, it, expect, afterAll } from 'vitest';
import { deployStack, destroyStack, type StackOutputs } from '../helpers/pulumi';

describe('StaticWebApp', function() {
	const stackName = `test-${Date.now()}`;
	let outputs: StackOutputs | undefined;
	let deploymentSucceeded = false;

	it('deploys successfully', async function() {
		outputs = await deployStack('examples/static-webapp', stackName);
		deploymentSucceeded = true;

		// Verify core outputs exist
		expect(outputs.bucketName).toBeDefined();
		expect(outputs.bucketUrl).toBeDefined();
		expect(outputs.backendBucketName).toBeDefined();

		// Verify bucket URL format
		expect(outputs.bucketUrl).toContain('storage.googleapis.com');
		expect(outputs.bucketUrl).toContain('index.html');
	}, 300_000); // 5 min timeout (simple GCS deployment)

	afterAll(async function() {
		// Only attempt cleanup if we have a stack to destroy
		if (deploymentSucceeded || outputs) {
			await destroyStack('examples/static-webapp', stackName);
		}
	}, 300_000); // 5 min timeout for destroy
});
