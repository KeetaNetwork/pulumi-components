import * as pulumi from '@pulumi/pulumi';
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
		[ 'a value that is stored as a secret', { TOKEN: { value: 'hidden', secret: true }}, [ { name: 'TOKEN', value: 'hidden' } ] ],
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
		[ 'the only variable is an existing secret', { DB_PASSWORD: { name: 'db-password', version: '3' }}, 'DB_PASSWORD' ],
		[ 'an existing secret follows plain values', { MODE: 'worker', API_KEY: { name: 'api-key', version: '1' }}, 'API_KEY' ]
	];

	it.each(unresolvable)('throws, naming the variable, when %s', async function(description, variables, variableName) {
		await expect(captureTree(function() {
			return(buildManager(`unresolvable-${description.replace(/ /g, '-')}`, variables).resolvedVariableOutput);
		})).rejects.toThrow(variableName);
	});
});

/*
 * One EnvManager holds the secrets of an app, and the service, the migration
 * job and the workers read views of it. A view only projects what the
 * manager made: it creates nothing, and it is not an error to hold one that
 * a runtime cannot use (only reading `resolvedForVm` of an existing secret is).
 */
describe('EnvManager.view', function() {
	const variables: Variables = {
		MODE: 'worker',
		TOKEN: { value: 'hidden', secret: true },
		EXISTING: { name: 'existing-secret', version: '3' }
	};
	const resolvable: Variables = { MODE: 'worker', TOKEN: { value: 'hidden', secret: true }};

	function namesOf(entries: { name?: pulumi.Input<string> }[]) {
		return(Promise.all(entries.map(function(entry) {
			return(resolveOutput(pulumi.output(entry.name)));
		})));
	}

	it('creates no resource, whatever the runtime that reads it', async function() {
		const alone = await captureTree(function() {
			return(buildManager('view-quiet', resolvable));
		});
		const viewed = await captureTree(function() {
			const manager = buildManager('view-quiet', resolvable);
			const view = manager.view({ EXTRA: 'extra' });

			return([ view.cloudRun, view.cloudRunJob, view.resolvedForVm, manager.view().cloudRun ]);
		});

		expect(viewed.resources.map(function(resource) {
			return(resource.urn);
		})).toEqual(alone.resources.map(function(resource) {
			return(resource.urn);
		}));
	});

	it('gives the Cloud Run form of the variables of the manager, and the overrides', async function() {
		let names: unknown;
		await captureTree(async function() {
			names = await namesOf(buildManager('view-cloud-run', variables).view({ EXTRA: 'extra' }).cloudRun);
		});

		expect(names).toEqual([ 'MODE', 'TOKEN', 'EXISTING', 'EXTRA' ]);
	});

	it('gives the Cloud Run job form: a secret as a reference, a plain value as a value', async function() {
		let entries: unknown;
		await captureTree(async function() {
			entries = await resolveOutput(pulumi.output(buildManager('view-job', variables).view({ EXTRA: 'extra' }).cloudRunJob));
		});

		expect(entries).toEqual([
			{ name: 'MODE', value: 'worker' },
			{ name: 'TOKEN', valueSource: { secretKeyRef: { secret: 'view-job-token', version: '1' }}},
			{ name: 'EXISTING', valueSource: { secretKeyRef: { secret: 'existing-secret', version: '3' }}},
			{ name: 'EXTRA', value: 'extra' }
		]);
	});

	it('lets an override replace the variable of the same name, once', async function() {
		let cloudRun: unknown;
		let job: unknown;
		await captureTree(async function() {
			const view = buildManager('view-replace', variables).view({ MODE: 'override' });
			cloudRun = await resolveOutput(pulumi.output(view.cloudRun));
			job = await resolveOutput(pulumi.output(view.cloudRunJob));
		});

		expect(cloudRun).toContainEqual({ name: 'MODE', value: 'override' });
		expect(job).toContainEqual({ name: 'MODE', value: 'override' });
		expect(JSON.stringify(cloudRun).split('"MODE"')).toHaveLength(2);
		expect(JSON.stringify(job).split('"MODE"')).toHaveLength(2);
	});

	it('gives the plain values for a virtual machine, with the overrides', async function() {
		let resolved: unknown;
		await captureTree(async function() {
			resolved = await resolveOutput(pulumi.output(buildManager('view-vm', resolvable).view({ EXTRA: 'extra' }).resolvedForVm));
		});

		expect(resolved).toEqual([ { name: 'MODE', value: 'worker' }, { name: 'TOKEN', value: 'hidden' }, { name: 'EXTRA', value: 'extra' } ]);
	});

	/* A service and a job can read an existing secret, a virtual machine cannot: only reading that form fails */
	it('holds a view with an existing secret without failing, for the runtimes that can read it', async function() {
		let names: unknown;
		await captureTree(async function() {
			const view = buildManager('view-existing', variables).view();
			names = [ await namesOf(view.cloudRun), await resolveOutput(pulumi.output(view.cloudRunJob)) ];
		});

		expect(names).toEqual([ [ 'MODE', 'TOKEN', 'EXISTING' ], expect.any(Array) ]);
	});

	it('throws, naming the variable, when a virtual machine reads an existing secret', async function() {
		await expect(captureTree(function() {
			return(buildManager('view-existing-vm', variables).view().resolvedForVm);
		})).rejects.toThrow('EXISTING');
	});
});
