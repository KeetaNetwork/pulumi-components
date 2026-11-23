import { describe, expect, it } from 'vitest';
import * as pulumi from '@pulumi/pulumi';

import { captureTree, describeTree, matchLegacyUrns, urnsOf } from './pulumi-tree';

/*
 * The test components below stand for the library's components. Both trees
 * are built through the real SDK, so the aliases are the ones the SDK sends.
 */
const LEAF = 'test:index:Leaf';
const BRANCH = 'test:index:Branch';

class Leaf extends pulumi.CustomResource {
	constructor(name: string, props: { [key: string]: pulumi.Input<unknown> }, opts?: pulumi.CustomResourceOptions) {
		super(LEAF, name, props, opts);
	}
}

function leaf(name: string, opts?: pulumi.CustomResourceOptions, props: { [key: string]: pulumi.Input<unknown> } = {}) {
	return(new Leaf(name, { size: 1, ...props }, opts));
}

/** A component with one leaf named after it, like the library's `${name}-bucket` children */
class Branch extends pulumi.ComponentResource {
	constructor(name: string, opts?: pulumi.ComponentResourceOptions, leafOpts?: pulumi.CustomResourceOptions) {
		super(BRANCH, name, {}, opts);

		leaf(`${name}-leaf`, { parent: this, ...leafOpts });
	}
}

describe('captureTree', function() {
	it('gives each resource the URN with every ancestor type in it', async function() {
		const tree = await captureTree(function() {
			const outer = new Branch('outer');
			const inner = new Branch('inner', { parent: outer });
			leaf('deep', { parent: inner });
		});

		expect(urnsOf(tree)).toEqual([
			'urn:pulumi:stack::project::test:index:Branch$test:index:Branch$test:index:Leaf::deep',
			'urn:pulumi:stack::project::test:index:Branch$test:index:Branch$test:index:Leaf::inner-leaf',
			'urn:pulumi:stack::project::test:index:Branch$test:index:Leaf::outer-leaf',
			'urn:pulumi:stack::project::test:index:Branch$test:index:Branch::inner',
			'urn:pulumi:stack::project::test:index:Branch::outer'
		].sort());
	});

	it('records resources that are created inside apply callbacks that another resource waits for', async function() {
		const tree = await captureTree(function() {
			const source = leaf('source');
			const delayed = source.id.apply(async function(id) {
				await new Promise(function(resolve) {
					setTimeout(resolve, 50);
				});
				leaf(`late-${id}`);

				return(id);
			});

			leaf('consumer', undefined, { dependsOnLate: delayed });
		});

		expect(tree.resources.map(function(resource) {
			return(resource.name);
		})).toEqual([ 'consumer', 'late-source-id', 'source' ]);
	});

	it('records the options that the snapshot pins', async function() {
		const tree = await captureTree(function() {
			const parent = new Branch('options');
			leaf('flags', { parent, protect: true, retainOnDelete: true, deletedWith: parent });
		});

		const flagged = tree.resources.find(function(resource) {
			return(resource.name === 'flags');
		});
		expect(flagged).toMatchObject({
			parent: 'urn:pulumi:stack::project::test:index:Branch::options',
			protect: true,
			retainOnDelete: true,
			deletedWith: 'urn:pulumi:stack::project::test:index:Branch::options'
		});
	});

	it('rejects a program that Pulumi would reject for a duplicate URN', async function() {
		await expect(captureTree(function() {
			leaf('twice');
			leaf('twice');
		})).rejects.toThrow(/registered twice/);
	});

	it('removes the project and stack from the URNs of a snapshot', async function() {
		const tree = await captureTree(function() {
			leaf('plain');
		});

		expect(describeTree(tree)).toEqual([ {
			urn: 'test:index:Leaf::plain',
			type: LEAF,
			name: 'plain',
			custom: true,
			aliases: [],
			inputs: { size: 1 }
		} ]);
	});
});

describe('matchLegacyUrns', function() {
	const legacyLeaf = 'urn:pulumi:stack::project::test:index:Leaf::app-leaf';

	it('matches a URN by the resource that still has it', async function() {
		const tree = await captureTree(function() {
			leaf('app-leaf');
		});

		expect(await matchLegacyUrns(tree, [ legacyLeaf ])).toEqual({ unmatched: [], ambiguous: [] });
	});

	it('reports a URN that no resource answers to', async function() {
		const tree = await captureTree(function() {
			return(new Branch('app'));
		});

		expect(await matchLegacyUrns(tree, [ legacyLeaf ])).toEqual({ unmatched: [ legacyLeaf ], ambiguous: [] });
	});

	it('matches a resource that moved under a parent when its alias names the old parent', async function() {
		const tree = await captureTree(function() {
			return(new Branch('app', undefined, { aliases: [ { parent: pulumi.rootStackResource } ] }));
		});

		expect(await matchLegacyUrns(tree, [ legacyLeaf ])).toEqual({ unmatched: [], ambiguous: [] });
	});

	it('does not match a moved resource whose alias names a different parent', async function() {
		const tree = await captureTree(function() {
			const elsewhere = new Branch('elsewhere');
			return(new Branch('app', undefined, { aliases: [ { parent: elsewhere } ] }));
		});

		expect(await matchLegacyUrns(tree, [ legacyLeaf ])).toEqual({ unmatched: [ legacyLeaf ], ambiguous: [] });
	});

	it('matches the children of a renamed parent through the alias the child inherits', async function() {
		const tree = await captureTree(function() {
			return(new Branch('renamed', { aliases: [ { name: 'app' } ] }));
		});

		expect(await matchLegacyUrns(tree, [
			'urn:pulumi:stack::project::test:index:Branch::app',
			'urn:pulumi:stack::project::test:index:Branch$test:index:Leaf::app-leaf'
		])).toEqual({ unmatched: [], ambiguous: [] });
	});

	it('passes the inherited alias down through a grandchild', async function() {
		const tree = await captureTree(function() {
			const renamed = new Branch('renamed', { aliases: [ { name: 'app' } ] });
			const inner = new Branch('renamed-inner', { parent: renamed });
			leaf('renamed-inner-deep', { parent: inner });
		});

		expect(await matchLegacyUrns(tree, [
			'urn:pulumi:stack::project::test:index:Branch$test:index:Branch$test:index:Leaf::app-inner-deep'
		])).toEqual({ unmatched: [], ambiguous: [] });
	});

	it('reports a URN that two resources answer to', async function() {
		const tree = await captureTree(function() {
			leaf('first', { aliases: [ { name: 'shared' } ] });
			leaf('second', { aliases: [ { name: 'shared' } ] });
		});

		expect(await matchLegacyUrns(tree, [ 'urn:pulumi:stack::project::test:index:Leaf::shared' ])).toEqual({
			unmatched: [],
			ambiguous: [ 'urn:pulumi:stack::project::test:index:Leaf::shared' ]
		});
	});
});

describe('secrets in a captured tree', function() {
	it('are masked in the inputs and in a snapshot, and unwrapped in `revealed`', async function() {
		const tree = await captureTree(function() {
			leaf('with-secret', undefined, { password: pulumi.secret('hunter2') });
		});
		const [ resource ] = tree.resources;

		expect(resource?.inputs).toMatchObject({ password: '<secret>' });
		expect(resource?.revealed).toMatchObject({ password: 'hunter2' });
		expect(JSON.stringify(describeTree(tree))).not.toContain('hunter2');
	});
});

describe('ignoreChanges in a captured tree', function() {
	it('are recorded when the resource names some, and absent otherwise', async function() {
		const tree = await captureTree(function() {
			leaf('ignores', { ignoreChanges: [ 'size' ] });
			leaf('keeps');
		});
		const [ ignores, keeps ] = [ 'ignores', 'keeps' ].map(function(name) {
			return(tree.resources.find(function(resource) {
				return(resource.name === name);
			}));
		});

		expect(ignores?.ignoreChanges).toEqual([ 'size' ]);
		expect(keeps?.ignoreChanges).toBeUndefined();
		expect(JSON.stringify(describeTree(tree))).toContain('"ignoreChanges"');
	});
});
