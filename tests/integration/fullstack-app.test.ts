import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deployStack, destroyStack, fetchWithRetry, previewStack, type StackOutputs } from '../helpers/pulumi';
import { expectArray, expectBoolean, expectDefined, expectRecord, expectString, expectStringArray } from '../helpers/narrow';

/* An unset or empty TEST_DOMAIN selects the default */
const configuredDomain = process.env.TEST_DOMAIN;
const baseDomain = (configuredDomain === undefined || configuredDomain === '') ? 'fullstack.pulumi-components-test-zone.test.keeta.com' : configuredDomain;

/* A prefix makes the domain unique to one run, inside the same DNS zone */
const domainPrefix = process.env.TEST_DOMAIN_PREFIX;
const domain = (domainPrefix === undefined || domainPrefix === '') ? baseDomain : `${domainPrefix}.${baseDomain}`;
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

		const serviceUrl = expectString(expectDefined(outputs, 'stack outputs').serviceUrl, 'serviceUrl');
		const response = await fetch(`${serviceUrl}/api/health`);
		const body = await response.text();
		expect(response.ok, `HTTP ${response.status}: ${body}`).toBe(true);

		const data = expectRecord(JSON.parse(body), 'health response');
		expect(data.status).toBe('ok');
		expect(data.database).toBeDefined();

		const env = expectRecord(data.env, 'health response env');
		expect(env.user).toBe('set');
		expect(env.password).toBe('set');
		expect(env.database).toBe('set');
		expect(env.host).toBe('set');
		expect(env.port).toBe('set');
	}, 60_000);

	it('verifies migrations ran', async function() {
		expect(outputs).toBeDefined();

		const serviceUrl = expectString(expectDefined(outputs, 'stack outputs').serviceUrl, 'serviceUrl');
		const response = await fetch(`${serviceUrl}/api/migrations`);
		const body = await response.text();
		expect(response.ok, `Migrations HTTP ${response.status}: ${body}`).toBe(true);

		const data = expectRecord(JSON.parse(body), 'migrations response');
		const rows = expectArray(data.rows, 'migrations rows');
		expect(data.status).toBe('ok');
		expect(data.count).toBeGreaterThan(0);
		expect(rows.length).toBeGreaterThan(0);
		expect(expectRecord(rows[0], 'first migrations row').name).toMatch(/^migration-/);
	}, 60_000);

	it('redirects HTTP to HTTPS on load balancer IP', async function() {
		expect(outputs).toBeDefined();

		const ips = expectStringArray(expectDefined(outputs, 'stack outputs').ips, 'ips');
		expect(ips.length).toBeGreaterThan(0);

		const ip = ips[0];
		const response = await fetchWithRetry(
			`http://${ip}/`,
			{ redirect: 'manual' },
			// Wait for URL map to be ready
			function(r) { return(r.status >= 300 && r.status < 400); }
		);
		expect(response.status).toBeGreaterThanOrEqual(300);
		expect(response.status).toBeLessThan(400);

		const location = response.headers.get('location');
		expect(location).toBeDefined();
		expect(location).toMatch(/^https:\/\//);
	}, 660_000);

	// Fetches from GCS directly because the LB's managed SSL cert is not
	// provisioned in time for the test run, causing ECONNRESET on HTTPS.
	// The HTTP redirect test above validates that LB routing is configured.
	it('serves frontend content', async function() {
		expect(outputs).toBeDefined();

		const appOutputs = expectRecord(expectDefined(outputs, 'stack outputs').app, 'app output');
		const frontendBucket = expectString(appOutputs.frontendBucket, 'app frontendBucket');
		expect(frontendBucket).toBeDefined();

		/* The frontend sets no cdn, so the backend bucket keeps CDN off */
		const frontend = expectRecord(appOutputs.frontend, 'app frontend');
		const backendBucket = expectRecord(frontend.backendBucket, 'app frontend backendBucket');
		expect(expectBoolean(backendBucket.enableCdn, 'backendBucket enableCdn')).toBe(false);

		const bucketUrl = `https://storage.googleapis.com/${frontendBucket}/index.html`;
		const response = await fetch(bucketUrl);
		expect(response.ok).toBe(true);

		const html = await response.text();
		expect(html).toContain('FullStack App Frontend');
	}, 60_000);

	it('does not rebuild the image when the source tarball is regenerated', async function() {
		expect(outputs).toBeDefined();

		/*
		 * Regenerate the tarball, as happens on another machine, and
		 * check that the build is not re-run
		 */
		fs.rmSync(path.join(os.homedir(), '.cache', 'pulumi-tarballs'), { recursive: true, force: true });

		const operations = await previewStack('examples/fullstack-app', stackName);
		const buildOperations = Object.entries(operations).filter(function([urn]) {
			return(urn.endsWith('-build'));
		});

		expect(buildOperations.length).toBeGreaterThan(0);
		for (const [urn, op] of buildOperations) {
			expect(op, urn).toBe('same');
		}
	}, 600_000);

	afterAll(async function() {
		await destroyStack('examples/fullstack-app', stackName);
	}, 1_800_000);
});
