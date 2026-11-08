import { describe, expect, it } from 'vitest';

import type * as cloudrun from '../../src/packages/gcp/cloudrun';
import { resolveOutput } from '../helpers/outputs';
import { requireSource } from './harness/load-sources';
import { captureTree } from './harness/pulumi-tree';

const { EnvManager } = requireSource<typeof cloudrun>('src/packages/gcp/cloudrun.ts');

type Variables = ConstructorParameters<typeof EnvManager>[1]['variables'];

function buildManager(name: string, variables: Variables) {
	return(new EnvManager(name, { variables, serviceAccount: 'serviceAccount:worker@project.iam.gserviceaccount.com', secretRegionName: 'us-central1' }));
}

/*
 * A GCE container cannot read Secret Manager references, so the resolved
 * variables only exist for values the deployment itself knows. A reference to
 * a secret that someone else owns cannot be resolved, and leaving it out
 * would start the worker without it.
 */
describe('EnvManager.resolvedVariableOutput', function() {
	const resolvable: [ string, Variables, { name: string, value: string }[] ][] = [
		[ 'plain values', { MODE: 'worker', PORT: 8080 }, [ { name: 'MODE', value: 'worker' }, { name: 'PORT', value: '8080' } ] ],
		[ 'a value that is stored as a secret', { TOKEN: { value: 'hidden', secret: true } }, [ { name: 'TOKEN', value: 'hidden' } ] ],
		[ 'no variables', {}, [] ]
	];

	it.each(resolvable)('resolves %s', async function(description, variables, expected) {
		let resolved: unknown;
		await captureTree(async function() {
			resolved = await resolveOutput(buildManager(`resolve-${description.replace(/ /g, '-')}`, variables).resolvedVariableOutput);
		});

		expect(resolved).toEqual(expected);
	});

	const unresolvable: [ string, Variables, string ][] = [
		[ 'the only variable is an existing secret', { DB_PASSWORD: { name: 'db-password', version: '3' } }, 'DB_PASSWORD' ],
		[ 'an existing secret follows plain values', { MODE: 'worker', API_KEY: { name: 'api-key', version: '1' } }, 'API_KEY' ]
	];

	it.each(unresolvable)('throws, naming the variable, when %s', async function(description, variables, variableName) {
		await expect(captureTree(function() {
			return(buildManager(`unresolvable-${description.replace(/ /g, '-')}`, variables).resolvedVariableOutput);
		})).rejects.toThrow(variableName);
	});
});
