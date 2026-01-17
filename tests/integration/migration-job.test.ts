import { describe, it, expect, afterAll } from 'vitest';
import { deployStack, destroyStack, type StackOutputs } from '../helpers/pulumi';

describe('MigrationJob', function() {
	const stackName = `test-${Date.now()}`;
	let outputs: StackOutputs | undefined;
	let deploymentSucceeded = false;

	it('runs actual SQL migrations successfully', async function() {
		outputs = await deployStack('examples/migration-job', stackName);
		deploymentSucceeded = true;

		// Verify database was created
		expect(outputs.databaseConnectionName).toBeDefined();
		expect(outputs.databaseName).toBeDefined();

		// Verify migration job ran
		expect(outputs.migrationJobName).toBeDefined();
		expect(outputs.migrationStatus).toBe('CONDITION_SUCCEEDED');

		// Verify logs are available
		expect(outputs.migrationLogUri).toBeDefined();

		// Verify VPC was created for connectivity
		expect(outputs.vpcName).toBeDefined();
		expect(outputs.subnetName).toBeDefined();
		expect(outputs.vpcConnectorName).toBeDefined();
	}, 1_800_000); // 30 min timeout for Cloud SQL + networking

	afterAll(async function() {
		if (deploymentSucceeded || outputs) {
			await destroyStack('examples/migration-job', stackName);
		}
	}, 1_800_000); // 30 min timeout for destroy (Cloud SQL takes a while)
});
