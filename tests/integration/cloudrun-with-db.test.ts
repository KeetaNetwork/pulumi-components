import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { describe, it, expect, afterAll } from 'vitest';
import { deployStack, destroyStack, testStackName, type StackOutputs } from '../helpers/pulumi';
import { expectRecord, expectString } from '../helpers/narrow';
import { expectDynamicOutputs, expectHealthyDatabaseService, expectMigrationsApplied } from '../helpers/service-checks';

const EXAMPLE = 'examples/cloudrun-with-db';

/** The secret and version that the deployed service reads API_TOKEN from */
function tokenReference(outputs: StackOutputs) {
	const reference = expectRecord(outputs.apiTokenReference, 'apiTokenReference');

	return({ secret: expectString(reference.name, 'the secret of API_TOKEN'), version: expectString(reference.key, 'the version of API_TOKEN') });
}

/** The state of a secret version: the secret may be named by its id or by its path */
async function stateOfVersion(client: SecretManagerServiceClient, secret: string, version: string) {
	const project = process.env.GOOGLE_PROJECT ?? process.env.GCLOUD_PROJECT ?? '';
	const [ found ] = await client.getSecretVersion({ name: `projects/${project}/secrets/${secret}/versions/${version}` });

	return(String(found.state));
}

describe('CloudRunService with Database', function() {
	const stackName = testStackName('db');
	let outputs: StackOutputs | undefined;

	it('deploys and connects to database', async function() {
		outputs = await deployStack(EXAMPLE, stackName);

		// Verify outputs
		expect(outputs.backend).toBeDefined();
		expect(outputs.serviceUrl).toBeDefined();

		// Verify database connectivity and the injected env vars
		const serviceUrl = expectString(outputs.serviceUrl, 'serviceUrl');
		await expectHealthyDatabaseService(serviceUrl);

		// Verify migrations ran by querying the test_migrations table
		await expectMigrationsApplied(`${serviceUrl}/migrations`);

		// The dynamic resources report their outputs: the digest of the local build pins the image, and the run of the migration reports its status
		expectDynamicOutputs(outputs);
	}, 1_800_000); // 30 min timeout for Cloud SQL + image build

	it('rolls onto a new secret version when the secret value changes, and disables the old one', async function() {
		const before = tokenReference(outputs ?? {});

		const changed = await deployStack(EXAMPLE, stackName, { apiToken: 'changed' });
		const after = tokenReference(changed);
		const client = new SecretManagerServiceClient();

		expect(after.secret).toBe(before.secret);
		expect(after.version).not.toBe(before.version);
		expect(await stateOfVersion(client, after.secret, after.version)).toBe('ENABLED');
		expect(await stateOfVersion(client, before.secret, before.version)).toBe('DISABLED');

		/* The revision that reads the new version started, so the service can still reach its database */
		await expectHealthyDatabaseService(expectString(changed.serviceUrl, 'serviceUrl'));
	}, 1_800_000);

	afterAll(async function() {
		await destroyStack(EXAMPLE, stackName);
	}, 1_800_000); // 30 min timeout for destroy (Cloud SQL teardown is slow)
});
