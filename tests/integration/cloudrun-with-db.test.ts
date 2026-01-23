import { describe, it, expect, afterAll } from 'vitest';
import { deployStack, destroyStack, type StackOutputs } from '../helpers/pulumi';

describe('CloudRunService with Database', function() {
	const stackName = `test-${Date.now()}`;
	let outputs: StackOutputs | undefined;
	let deploymentSucceeded = false;

	it('deploys and connects to database', async function() {
		outputs = await deployStack('examples/cloudrun-with-db', stackName);
		deploymentSucceeded = true;

		// Verify outputs
		expect(outputs.backend).toBeDefined();
		expect(outputs.serviceUrl).toBeDefined();

		// Make HTTP request to verify database connectivity
		const serviceUrl = outputs.serviceUrl as string;
		const response = await fetch(serviceUrl);
		const body = await response.text();
		expect(response.ok, `HTTP ${response.status}: ${body}`).toBe(true);

		// Verify database connection succeeded
		const data = JSON.parse(body) as {
			status: string;
			database: string;
			env: Record<string, string>;
		};
		expect(data.status).toBe('ok');
		expect(data.database).toBeDefined();

		// Verify env vars were injected ("set" means the env var was injected)
		expect(data.env.user).toBe('set');
		expect(data.env.password).toBe('set');
		expect(data.env.database).toBe('set');
		expect(data.env.host).toBe('set');
		expect(data.env.port).toBe('set');
	}, 1_800_000); // 30 min timeout for Cloud SQL + image build

	afterAll(async function() {
		if (deploymentSucceeded || outputs) {
			await destroyStack('examples/cloudrun-with-db', stackName);
		}
	}, 900_000); // 15 min timeout for destroy
});
