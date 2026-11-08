import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';
import { GoogleAuth } from 'google-auth-library';
import { describe, expect, it } from 'vitest';

import type * as clientAuth from '../../src/packages/gcp/client-auth';
import { expectRecord } from '../helpers/narrow';
import { resolveOutput } from '../helpers/outputs';
import { requireSource } from './harness/load-sources';
import { captureTree } from './harness/pulumi-tree';

const { clientAuthInputs, googleAuthFrom } = requireSource<typeof clientAuth>('src/packages/gcp/client-auth.ts');

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
