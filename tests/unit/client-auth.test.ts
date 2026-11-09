import { CloudBuildClient } from '@google-cloud/cloudbuild';
import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';
import { GoogleAuth, Impersonated } from 'google-auth-library';
import { googleAuthLibrary } from 'google-gax';
import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type * as clientAuth from '../../src/packages/gcp/client-auth';
import { expectRecord } from '../helpers/narrow';
import { resolveOutput } from '../helpers/outputs';
import { requireSource } from './harness/load-sources';
import { captureTree } from './harness/pulumi-tree';

const { callerOf, clientAuthInputs, googleAuthForClient, googleAuthFrom } = requireSource<typeof clientAuth>('src/packages/gcp/client-auth.ts');

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

async function callerOfComponent(optionsOf: () => pulumi.ComponentResourceOptions) {
	let caller: unknown;
	await captureTree(async function() {
		const component = new pulumi.ComponentResource('test:index:Caller', 'caller', {}, optionsOf());
		caller = await resolveOutput(pulumi.output(clientAuthInputs(callerOf(component, 'project-id'))));
	});

	return(expectRecord(caller, 'the caller'));
}

/*
 * The builds, uploads, migrations and pushes of a component run as the
 * account that its GCP resources run as.
 */
describe('callerOf', function() {
	const configured = 'configured@project-id.iam.gserviceaccount.com';

	beforeAll(function() {
		pulumi.runtime.setAllConfig({ 'gcp:impersonateServiceAccount': configured });
	});

	afterAll(function() {
		pulumi.runtime.setAllConfig({});
	});

	it('takes the account of the stack configuration when the component has no GCP provider', async function() {
		expect(await callerOfComponent(function() { return({}); })).toEqual({ project: 'project-id', impersonateServiceAccount: configured });
	});

	it('takes the account of the GCP provider of the component over the stack configuration', async function() {
		const caller = await callerOfComponent(function() {
			return({ providers: [ new gcp.Provider('explicit', { project: 'project-id', impersonateServiceAccount: 'explicit@project-id.iam.gserviceaccount.com' }) ] });
		});

		expect(caller.impersonateServiceAccount).toBe('explicit@project-id.iam.gserviceaccount.com');
	});
});

/*
 * Application Default Credentials of a made-up service account: loading them
 * needs no network, and no test asks for a token.
 */
function useFakeApplicationDefaultCredentials() {
	let directory: string | undefined;

	beforeAll(function() {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'client-auth-'));
		const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
		const keyFile = path.join(directory, 'adc.json');
		fs.writeFileSync(keyFile, JSON.stringify({
			type: 'service_account',
			project_id: 'project-id',
			client_email: 'adc@project-id.iam.gserviceaccount.com',
			private_key: privateKey.export({ type: 'pkcs8', format: 'pem' })
		}));
		vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', keyFile);
	});

	afterAll(function() {
		vi.unstubAllEnvs();
		if (directory !== undefined) {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
}

describe('googleAuthFrom', function() {
	useFakeApplicationDefaultCredentials();

	const target = 'deployer@project-id.iam.gserviceaccount.com';
	const scopes = [ 'https://www.googleapis.com/auth/devstorage.read_write' ];

	it('impersonates the account of the inputs with the scopes it is given', async function() {
		const auth = await googleAuthFrom({ project: 'project-id', impersonateServiceAccount: target }, scopes);
		const client = await auth.getClient();

		expect(client).toBeInstanceOf(Impersonated);
		expect(client).toMatchObject({ targetPrincipal: target, targetScopes: scopes });
	});

	it('uses the credentials of the environment when the inputs name no account', async function() {
		const auth = await googleAuthFrom({ project: 'project-id' }, scopes);
		const client = await auth.getClient();

		expect(auth).toBeInstanceOf(GoogleAuth);
		expect(client).not.toBeInstanceOf(Impersonated);
		expect(client).toMatchObject({ email: 'adc@project-id.iam.gserviceaccount.com' });
	});
});

/*
 * The real google-gax and the real client, with the fake Application Default
 * Credentials: getClient() reads them without a request.
 */
describe('googleAuthForClient with a Google Cloud client', function() {
	useFakeApplicationDefaultCredentials();

	const account = 'deployer@project-id.iam.gserviceaccount.com';

	it('makes the client call as the account, with the Impersonated of its own google-gax', async function() {
		const client = new CloudBuildClient({ projectId: 'project-id', auth: await googleAuthForClient('@google-cloud/cloudbuild', { project: 'project-id', impersonateServiceAccount: account }) });

		const authClient = await client.auth.getClient();

		expect(authClient).toBeInstanceOf(googleAuthLibrary.Impersonated);
		expect(Reflect.get(authClient, 'targetPrincipal')).toBe(account);
	});

	it.each([
		[ 'no inputs', undefined ],
		[ 'inputs with no account to impersonate', { project: 'project-id' } ]
	])('leaves the client with the credentials of the environment for %s', async function(_description, inputs) {
		const auth = await googleAuthForClient('@google-cloud/cloudbuild', inputs);
		const client = new CloudBuildClient({ projectId: 'project-id', auth });

		const authClient = await client.auth.getClient();

		expect(auth).toBeUndefined();
		expect(authClient).not.toBeInstanceOf(googleAuthLibrary.Impersonated);
		expect(Reflect.get(authClient, 'email')).toBe('adc@project-id.iam.gserviceaccount.com');
	});
});
