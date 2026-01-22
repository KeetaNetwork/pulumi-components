import { describe, it, expect, afterAll } from 'vitest';
import { deployStack, destroyStack, type StackOutputs } from '../helpers/pulumi';

describe('MigrationJob', function() {
	const stackName = `test-${Date.now()}`;
	let outputs: StackOutputs | undefined;
	let deploymentSucceeded = false;

	it('runs actual SQL migrations successfully', async function() {
		outputs = await deployStack('examples/migration-job', stackName);
		deploymentSucceeded = true;

		// Verify components were created
		expect(outputs.vpc).toBeDefined();
		expect(outputs.db).toBeDefined();
		expect(outputs.migration).toBeDefined();
	}, 1_800_000); // 30 min timeout for Cloud SQL + networking

	afterAll(async function() {
		if (deploymentSucceeded || outputs) {
			await destroyStack('examples/migration-job', stackName);
		}
	}, 1_800_000); // 30 min timeout for destroy (Cloud SQL takes a while)
});
