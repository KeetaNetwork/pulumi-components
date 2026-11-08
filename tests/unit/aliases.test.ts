import * as pulumi from '@pulumi/pulumi';
import { describe, expect, it } from 'vitest';

import type * as aliases from '../../src/packages/gcp/aliases';
import { resolveOutput } from '../helpers/outputs';
import { requireSource } from './harness/load-sources';
import { captureTree } from './harness/pulumi-tree';

const { legacyUrn, movedFrom } = requireSource<typeof aliases>('src/packages/gcp/aliases.ts');

type OldParent = Parameters<typeof legacyUrn>[2];

const PREFIX = 'urn:pulumi:stack::project::';
const TYPE = 'gcp:storage/bucket:Bucket';
const OLD_PARENT_URN = `${PREFIX}Keeta:GCP:CloudRunService::old-parent`;

/** A URN is only known inside a program: the stack and the project are part of it */
async function inProgram<Value>(read: () => Promise<Value>): Promise<Value> {
	let value: Value | undefined;
	await captureTree(async function() {
		value = await read();
	});

	if (value === undefined) {
		throw(new Error('The program did not run'));
	}

	return(value);
}

const oldParents: [ string, () => OldParent, string ][] = [
	[ 'the stack', function() {
		return({ kind: 'stack' });
	}, `${PREFIX}${TYPE}::item` ],
	[ 'a resource given by its URN', function() {
		return({ kind: 'resource', urn: OLD_PARENT_URN });
	}, `${PREFIX}Keeta:GCP:CloudRunService$${TYPE}::item` ],
	[ 'a resource given by an Output', function() {
		return({ kind: 'resource', urn: pulumi.output(OLD_PARENT_URN) });
	}, `${PREFIX}Keeta:GCP:CloudRunService$${TYPE}::item` ],
	[ 'a parent that moved too, given by its own legacy URN', function() {
		return({ kind: 'resource', urn: legacyUrn('old-parent', 'Keeta:GCP:CloudRunService', { kind: 'stack' }) });
	}, `${PREFIX}Keeta:GCP:CloudRunService$${TYPE}::item` ]
];

describe('legacyUrn', function() {
	it.each(oldParents)('is the URN of a resource whose old parent is %s', async function(_description, oldParent, expected) {
		expect(await inProgram(function() {
			return(resolveOutput(legacyUrn('item', TYPE, oldParent())));
		})).toBe(expected);
	});
});

/*
 * What a resource records as its aliases is what the engine receives, so the
 * test reads it where the harness does: from the registration.
 */
describe('movedFrom', function() {
	it.each(oldParents)('gives a resource whose old parent is %s exactly one alias, its old URN', async function(_description, oldParent, expected) {
		const tree = await captureTree(function() {
			const parent = new pulumi.ComponentResource('Keeta:GCP:CloudRunService', 'new-parent', {});

			return(new pulumi.ComponentResource(TYPE, 'item', {}, { parent, aliases: movedFrom('item', TYPE, oldParent()) }));
		});
		const item = tree.resources.find(function(resource) {
			return(resource.name === 'item');
		});

		expect(item?.aliases).toEqual([ expected ]);
	});
});
