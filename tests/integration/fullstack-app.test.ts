import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deployStack, destroyStack, testStackName, fetchWithRetry, previewStack, type StackOutputs } from '../helpers/pulumi';
import { expectBoolean, expectDefined, expectRecord, expectString, expectStringArray } from '../helpers/narrow';
import { expectDynamicOutputs, expectHealthyDatabaseService, expectMigrationsApplied } from '../helpers/service-checks';

/* An unset or empty TEST_DOMAIN selects the default */
const configuredDomain = process.env.TEST_DOMAIN;
let baseDomain = 'fullstack.pulumi-components-test-zone.test.keeta.com';
if (configuredDomain !== undefined && configuredDomain !== '') {
	baseDomain = configuredDomain;
}

/* A prefix makes the domain unique to one run, inside the same DNS zone */
const domainPrefix = process.env.TEST_DOMAIN_PREFIX;
let domain = baseDomain;
if (domainPrefix !== undefined && domainPrefix !== '') {
	domain = `${domainPrefix}.${baseDomain}`;
}
const dnsZoneId = process.env.TEST_DNS_ZONE_ID;

describe('FullStackApp', function() {
	const stackName = testStackName('fs');
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

		// The dynamic resources report their outputs: the digest from Cloud Build pins the image, and the run of the migration reports its status
		expectDynamicOutputs(outputs);
	}, 1_800_000);

	it('serves API health check via Cloud Run', async function() {
		expect(outputs).toBeDefined();

		const serviceUrl = expectString(expectDefined(outputs, 'stack outputs').serviceUrl, 'serviceUrl');
		await expectHealthyDatabaseService(`${serviceUrl}/api/health`);
	}, 60_000);

	it('verifies migrations ran', async function() {
		expect(outputs).toBeDefined();

		const serviceUrl = expectString(expectDefined(outputs, 'stack outputs').serviceUrl, 'serviceUrl');
		await expectMigrationsApplied(`${serviceUrl}/api/migrations`);
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
