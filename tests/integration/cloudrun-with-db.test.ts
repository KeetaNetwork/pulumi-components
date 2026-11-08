import { describe, it, expect, afterAll } from 'vitest';
import { deployStack, destroyStack, type StackOutputs } from '../helpers/pulumi';
import { expectArray, expectRecord, expectString } from '../helpers/narrow';

describe('CloudRunService with Database', function() {
	const stackName = `test-${Date.now()}`;
	let outputs: StackOutputs | undefined;

	it('deploys and connects to database', async function() {
		outputs = await deployStack('examples/cloudrun-with-db', stackName);

		// Verify outputs
		expect(outputs.backend).toBeDefined();
		expect(outputs.serviceUrl).toBeDefined();

		// Make HTTP request to verify database connectivity
		const serviceUrl = expectString(outputs.serviceUrl, 'serviceUrl');
		const response = await fetch(serviceUrl);
		const body = await response.text();
		expect(response.ok, `HTTP ${response.status}: ${body}`).toBe(true);

		// Verify database connection succeeded
		const data = expectRecord(JSON.parse(body), 'health response');
		expect(data.status).toBe('ok');
		expect(data.database).toBeDefined();

		// Verify env vars were injected ("set" means the env var was injected)
		const env = expectRecord(data.env, 'health response env');
		expect(env.user).toBe('set');
		expect(env.password).toBe('set');
		expect(env.database).toBe('set');
		expect(env.host).toBe('set');
		expect(env.port).toBe('set');

		// Verify migrations ran by querying the test_migrations table
		const migrationsResponse = await fetch(`${serviceUrl}/migrations`);
		const migrationsBody = await migrationsResponse.text();
		expect(migrationsResponse.ok, `Migrations HTTP ${migrationsResponse.status}: ${migrationsBody}`).toBe(true);

		const migrationsData = expectRecord(JSON.parse(migrationsBody), 'migrations response');
		const rows = expectArray(migrationsData.rows, 'migrations rows');
		expect(migrationsData.status).toBe('ok');
		expect(migrationsData.count).toBeGreaterThan(0);
		expect(rows.length).toBeGreaterThan(0);
		expect(expectRecord(rows[0], 'first migrations row').name).toMatch(/^migration-/);
	}, 1_800_000); // 30 min timeout for Cloud SQL + image build

	afterAll(async function() {
		await destroyStack('examples/cloudrun-with-db', stackName);
	}, 1_800_000); // 30 min timeout for destroy (Cloud SQL teardown is slow)
});
