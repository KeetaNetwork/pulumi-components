import { describe, it, expect, afterAll } from 'vitest';
import { deployStack, destroyStack, type StackOutputs } from '../helpers/pulumi';

describe('CloudRunService', function() {
	const stackName = `test-${Date.now()}`;
	let outputs: StackOutputs | undefined;
	let deploymentSucceeded = false;

	it('deploys successfully', async function() {
		outputs = await deployStack('examples/cloudrun-simple', stackName);
		deploymentSucceeded = true;

		// Verify core outputs exist
		expect(outputs.project).toBeDefined();
		expect(outputs.serviceName).toBeDefined();
		expect(outputs.serviceUrl).toBeDefined();
		expect(outputs.backendServiceId).toBeDefined();

		// Verify database was created
		expect(outputs.databaseConnectionName).toBeDefined();

		// Verify VPC was created
		expect(outputs.vpcName).toBeDefined();
		expect(outputs.subnetName).toBeDefined();
		expect(outputs.vpcConnectorName).toBeDefined();

		// Verify MIG was created
		expect(outputs.migInstanceGroupId).toBeDefined();

		// Verify service account
		expect(outputs.serviceAccountEmail).toBeDefined();
	}, 1_800_000); // 30 min timeout for Cloud SQL + networking

	afterAll(async function() {
		// Only attempt cleanup if we have a stack to destroy
		if (deploymentSucceeded || outputs) {
			await destroyStack('examples/cloudrun-simple', stackName);
		}
	}, 900_000); // 15 min timeout for destroy
});
