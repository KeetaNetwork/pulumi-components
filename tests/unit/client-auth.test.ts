import { CloudBuildClient } from '@google-cloud/cloudbuild';
import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';
import { GoogleAuth } from 'google-auth-library';
import { googleAuthLibrary } from 'google-gax';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as clientAuth from '../../src/packages/gcp/client-auth';
import { expectRecord } from '../helpers/narrow';
import { resolveOutput } from '../helpers/outputs';
import { requireSource } from './harness/load-sources';
import { captureTree } from './harness/pulumi-tree';
import { useTempDirectories } from '../helpers/temp-directories';

const { authenticateAs, clientAuthInputs, googleAuthFrom } = requireSource<typeof clientAuth>('src/packages/gcp/client-auth.ts');

async function inputsOfProvider(args: gcp.ProviderArgs) {
	let inputs: unknown;
	await captureTree(async function() {
		const provider = new gcp.Provider('caller-provider', args);
		inputs = await resolveOutput(pulumi.output(clientAuthInputs(provider)));
	});

	return(expectRecord(inputs, 'the client auth inputs'));
}

/*
 * The inputs go into the state of every dynamic resource that uses them, so
 * they hold what identifies the caller and nothing that authenticates it.
 */
describe('clientAuthInputs', function() {
	it('keeps only the project and the account to impersonate of a provider', async function() {
		const inputs = await inputsOfProvider({
			project: 'project-id',
			impersonateServiceAccount: 'deployer@project-id.iam.gserviceaccount.com',
			accessToken: 'short-lived-token',
			credentials: '{"private_key":"secret"}'
		});

		expect(inputs).toEqual({ project: 'project-id', impersonateServiceAccount: 'deployer@project-id.iam.gserviceaccount.com' });
		expect(JSON.stringify(inputs)).not.toContain('short-lived-token');
		expect(JSON.stringify(inputs)).not.toContain('private_key');
	});

	it('has no account to impersonate when the provider names none', async function() {
		const inputs = await inputsOfProvider({ project: 'project-id' });

		expect(inputs.project).toBe('project-id');
		expect(inputs.impersonateServiceAccount).toBeUndefined();
	});
});

describe('googleAuthFrom', function() {
	it.each([
		[ 'a project and an account to impersonate', { project: 'project-id', impersonateServiceAccount: 'deployer@project-id.iam.gserviceaccount.com' } ],
		[ 'a project only', { project: 'project-id' } ]
	])('builds a GoogleAuth from %s without calling anything', function(_description, inputs) {
		expect(googleAuthFrom(inputs)).toBeInstanceOf(GoogleAuth);
	});
});

/*
 * The real google-gax and the real client: the credentials are a service
 * account key made here, and getClient() reads them without a request.
 */
describe('authenticateAs with a Google Cloud client', function() {
	const directories = useTempDirectories();
	const account = 'deployer@project-id.iam.gserviceaccount.com';

	afterEach(function() {
		vi.unstubAllEnvs();
	});

	function clientWithKey() {
		const { privateKey } = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
			publicKeyEncoding: { type: 'spki', format: 'pem' }
		});
		const directory = directories.make({
			'key.json': JSON.stringify({ type: 'service_account', project_id: 'project-id', client_email: 'source@project-id.iam.gserviceaccount.com', private_key: privateKey })
		});
		vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', path.join(directory, 'key.json'));

		return(new CloudBuildClient({ projectId: 'project-id' }));
	}

	it('makes the client call as the account, with the Impersonated of its own google-gax', async function() {
		const client = clientWithKey();
		authenticateAs(client, '@google-cloud/cloudbuild', { project: 'project-id', impersonateServiceAccount: account });

		const authClient = await client.auth.getClient();

		expect(authClient).toBeInstanceOf(googleAuthLibrary.Impersonated);
		expect(Reflect.get(authClient, 'targetPrincipal')).toBe(account);
	});

	it('leaves a client that has no account to impersonate with the credentials it found', async function() {
		const client = clientWithKey();
		authenticateAs(client, '@google-cloud/cloudbuild', { project: 'project-id' });

		const authClient = await client.auth.getClient();

		expect(authClient).not.toBeInstanceOf(googleAuthLibrary.Impersonated);
		expect(Reflect.get(authClient, 'email')).toBe('source@project-id.iam.gserviceaccount.com');
	});
});
