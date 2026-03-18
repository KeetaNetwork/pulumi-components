import { describe, it, expect, afterAll } from 'vitest';
import { deployStack, destroyStack, type StackOutputs } from '../helpers/pulumi';

const domain = process.env.TEST_DOMAIN || 'fullstack-test.dev.keeta.com';
const dnsZoneId = process.env.TEST_DNS_ZONE_ID;

describe('FullStackApp', function() {
	const stackName = `test-${Date.now()}`;
	let outputs: StackOutputs | undefined;

	it('deploys fullstack app with load balancer and database', async function() {
		const extraConfig: { [key: string]: string } = {
			'fullstack-app:domain': domain
		};
		if (dnsZoneId) {
			extraConfig['fullstack-app:dnsZoneId'] = dnsZoneId;
		}

		outputs = await deployStack('examples/fullstack-app', stackName, extraConfig);

		expect(outputs.app).toBeDefined();
		expect(outputs.serviceUrl).toBeDefined();
		expect(outputs.ips).toBeDefined();
	}, 1_800_000);

	it('serves API health check via Cloud Run', async function() {
		expect(outputs).toBeDefined();

		const serviceUrl = outputs!.serviceUrl as string;
		const response = await fetch(`${serviceUrl}/api/health`);
		const body = await response.text();
		expect(response.ok, `HTTP ${response.status}: ${body}`).toBe(true);

		const data = JSON.parse(body) as {
			status: string;
			database: string;
			env: { [key: string]: string };
		};
		expect(data.status).toBe('ok');
		expect(data.database).toBeDefined();
		expect(data.env.user).toBe('set');
		expect(data.env.password).toBe('set');
		expect(data.env.database).toBe('set');
		expect(data.env.host).toBe('set');
		expect(data.env.port).toBe('set');
	}, 60_000);

	it('verifies migrations ran', async function() {
		expect(outputs).toBeDefined();

		const serviceUrl = outputs!.serviceUrl as string;
		const response = await fetch(`${serviceUrl}/api/migrations`);
		const body = await response.text();
		expect(response.ok, `Migrations HTTP ${response.status}: ${body}`).toBe(true);

		const data = JSON.parse(body) as {
			status: string;
			count: number;
			rows: Array<{ id: number; name: string; created_at: string }>;
		};
		expect(data.status).toBe('ok');
		expect(data.count).toBeGreaterThan(0);
		expect(data.rows.length).toBeGreaterThan(0);
		expect(data.rows[0].name).toMatch(/^migration-/);
	}, 60_000);

	it('redirects HTTP to HTTPS on load balancer IP', async function() {
		expect(outputs).toBeDefined();

		const ips = outputs!.ips as string[];
		expect(ips.length).toBeGreaterThan(0);

		const ip = ips[0];
		const response = await fetch(`http://${ip}/`, { redirect: 'manual' });
		expect(response.status).toBeGreaterThanOrEqual(300);
		expect(response.status).toBeLessThan(400);

		const location = response.headers.get('location');
		expect(location).toBeDefined();
		expect(location).toMatch(/^https:\/\//);
	}, 60_000);

	// Fetches from GCS directly because the LB's managed SSL cert is not
	// provisioned in time for the test run, causing ECONNRESET on HTTPS.
	// The HTTP redirect test above validates that LB routing is configured.
	it('serves frontend content', async function() {
		expect(outputs).toBeDefined();

		const appOutputs = outputs!.app as { frontendBucket: string };
		expect(appOutputs.frontendBucket).toBeDefined();

		const bucketUrl = `https://storage.googleapis.com/${appOutputs.frontendBucket}/index.html`;
		const response = await fetch(bucketUrl);
		expect(response.ok).toBe(true);

		const html = await response.text();
		expect(html).toContain('FullStack App Frontend');
	}, 60_000);

	afterAll(async function() {
		await destroyStack('examples/fullstack-app', stackName);
	}, 1_800_000);
});
