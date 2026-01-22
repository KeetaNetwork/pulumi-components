import { describe, it, expect, afterAll } from 'vitest';
import { deployStack, destroyStack, type StackOutputs } from '../helpers/pulumi';

describe('CloudRunService', function() {
	const stackName = `test-${Date.now()}`;
	let outputs: StackOutputs | undefined;
	let deploymentSucceeded = false;

	it('deploys successfully', async function() {
		outputs = await deployStack('examples/cloudrun-simple', stackName);
		deploymentSucceeded = true;

		// Verify outputs
		expect(outputs.backend).toBeDefined();
		expect(outputs.serviceUrl).toBeDefined();

		// Make HTTP request to verify service is running
		const serviceUrl = outputs.serviceUrl as string;
		const response = await fetch(serviceUrl);
		expect(response.ok).toBe(true);
	}, 1_800_000); // 30 min timeout for Cloud SQL + networking

	afterAll(async function() {
		if (deploymentSucceeded || outputs) {
			await destroyStack('examples/cloudrun-simple', stackName);
		}
	}, 900_000); // 15 min timeout for destroy
});
