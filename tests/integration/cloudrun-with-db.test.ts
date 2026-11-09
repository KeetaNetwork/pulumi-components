import { describe, it, expect, afterAll } from 'vitest';
import { deployStack, destroyStack, testStackName, type StackOutputs } from '../helpers/pulumi';
import { expectString } from '../helpers/narrow';
import { expectHealthyDatabaseService, expectMigrationsApplied } from '../helpers/service-checks';

describe('CloudRunService with Database', function() {
	const stackName = testStackName('db');
	let outputs: StackOutputs | undefined;

	it('deploys and connects to database', async function() {
		outputs = await deployStack('examples/cloudrun-with-db', stackName);

		// Verify outputs
		expect(outputs.backend).toBeDefined();
		expect(outputs.serviceUrl).toBeDefined();

		// Verify database connectivity and the injected env vars
		const serviceUrl = expectString(outputs.serviceUrl, 'serviceUrl');
		await expectHealthyDatabaseService(serviceUrl);

		// Verify migrations ran by querying the test_migrations table
		await expectMigrationsApplied(`${serviceUrl}/migrations`);
	}, 1_800_000); // 30 min timeout for Cloud SQL + image build

	afterAll(async function() {
		await destroyStack('examples/cloudrun-with-db', stackName);
	}, 1_800_000); // 30 min timeout for destroy (Cloud SQL teardown is slow)
});
