import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { expectDefined, expectRecord } from '../helpers/narrow';
import { captureTree, describeTree, matchLegacyUrns, readBaselineCase, urnsOf, useIsolatedHome } from './harness/pulumi-tree';
import type { TreeSnapshot } from './harness/pulumi-tree';
import { TREE_CASES } from './harness/tree-cases';

/*
 * Pins the resource tree of every component: each resource's URN, type,
 * parent, aliases, provider, lifecycle options and key inputs. A change that
 * moves, renames, re-parents or re-provisions a resource shows up as a
 * snapshot diff, and the URN check proves that every resource of the last
 * release is still matched by a resource of the new tree.
 *
 * Run it alone with: npx vitest run tests/unit/component-tree.test.ts
 */

const BASELINE_VERSION = '1.0.95';
const baselinePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'urn-baselines', `${BASELINE_VERSION}.json`);

/*
 * URNs of the released version that this branch deliberately no longer
 * answers to, per case. The reason names the phase that drops the URN and
 * what it drops, for example 'P7: build provider removed'. The table is
 * empty until a phase drops a URN on purpose. An entry that is still
 * matched fails the test, so entries cannot go stale.
 */
const PLANNED_EXCEPTIONS: { [caseName: string]: { [urn: string]: string }} = {};

const caseNames = TREE_CASES.map(function(treeCase) {
	return(treeCase.name);
});

describe('component tree', function() {
	useIsolatedHome();

	const trees = new Map<string, TreeSnapshot>();

	beforeAll(async function() {
		/* One at a time: the Pulumi runtime state is process-wide */
		for (const treeCase of TREE_CASES) {
			trees.set(treeCase.name, await captureTree(treeCase.build));
		}
	});

	function treeOf(caseName: string) {
		return(expectDefined(trees.get(caseName), `the tree of case ${caseName}`));
	}

	describe('snapshot', function() {
		it.each(caseNames)('%s keeps its resources, parents, aliases and key inputs', function(caseName) {
			expect(describeTree(treeOf(caseName))).toMatchSnapshot();
		});

		it.each(caseNames)('%s has a registered parent for every child', function(caseName) {
			const tree = treeOf(caseName);
			const urns = new Set(urnsOf(tree));
			const orphans = tree.resources.filter(function(resource) {
				return(resource.parent !== undefined && !urns.has(resource.parent));
			});

			expect(orphans).toEqual([]);
		});

		/*
		 * The components the cases build. An exported component that no case
		 * builds (ECDSAKeyPair, and the load balancers until they get cases)
		 * is not in this list.
		 */
		it('builds these components across its cases', function() {
			const componentTypes = new Set<string>();
			for (const caseName of caseNames) {
				for (const resource of treeOf(caseName).resources) {
					if (!resource.custom) {
						componentTypes.add(resource.type);
					}
				}
			}

			expect([ ...componentTypes ].sort()).toEqual([
				'Keeta:GCP:CloudRunEnvManager',
				'Keeta:GCP:CloudRunService',
				'Keeta:GCP:ContainerCloudRun',
				'Keeta:GCP:ContainerMIG',
				'Keeta:GCP:DockerImage',
				'Keeta:GCP:FullStackApp',
				'Keeta:GCP:MigrationJob',
				'Keeta:GCP:PostgresCloudSQL',
				'Keeta:GCP:StaticWebApp',
				'keeta:synced-folder:GoogleCloudFolderWithArgs'
			]);
		});
	});

	describe(`URNs of ${BASELINE_VERSION}`, function() {
		const baseline: unknown = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

		it('are recorded for exactly the cases of this file', function() {
			const recorded = Object.keys(expectRecord(expectRecord(baseline, 'the baseline').cases, 'the cases of the baseline')).sort();

			expect(recorded).toEqual([ ...caseNames ].sort());
		});

		it.each(caseNames)('%s still answers to every one, each exactly once', async function(caseName) {
			const planned = Object.keys(PLANNED_EXCEPTIONS[caseName] ?? {});
			const result = await matchLegacyUrns(treeOf(caseName), readBaselineCase(baseline, caseName));

			expect({
				unplanned: result.unmatched.filter(function(urn) {
					return(!planned.includes(urn));
				}),
				ambiguous: result.ambiguous,
				plannedButMatched: planned.filter(function(urn) {
					return(!result.unmatched.includes(urn));
				})
			}).toEqual({ unplanned: [], ambiguous: [], plannedButMatched: [] });
		});
	});

	/*
	 * Records which children get the provider passed to a component today.
	 * Pulumi hands `providers` down to children that have the component as
	 * an ancestor, so a resource without a parent (or under one) is created
	 * with the default provider instead. The parenting phase changes this
	 * behaviour. When it does, this snapshot changes with it.
	 */
	describe('provider propagation', function() {
		function gcpNamesByProvider(caseName: string) {
			const resources = treeOf(caseName).resources.filter(function(resource) {
				return(resource.custom && resource.type.startsWith('gcp:'));
			});
			const namesWhere = function(hasProvider: boolean) {
				return(resources.filter(function(resource) {
					return((resource.provider !== undefined) === hasProvider);
				}).map(function(resource) {
					return(resource.name);
				}));
			};

			return({ withProvider: namesWhere(true), withoutProvider: namesWhere(false) });
		}

		it('gives the passed provider to the descendants of the component only', function() {
			expect(gcpNamesByProvider('service-providers')).toMatchSnapshot();
		});

		it('leaves the resources of the unparented docker image on the default provider', function() {
			const { withProvider, withoutProvider } = gcpNamesByProvider('service-providers');
			const imageResources = [ 'iam-bucket', 'iam-logs', 'iam-builds', 'iam-serviceAgent' ].map(function(suffix) {
				return(`service-providers-image-${suffix}`);
			});

			expect(withoutProvider).toEqual(expect.arrayContaining(imageResources));
			expect(withProvider).toEqual(expect.arrayContaining([ 'service-providers-api', 'service-providers-vpc', 'service-providers-db-master' ]));
		});

		it('uses the default provider everywhere when none is passed', function() {
			expect(gcpNamesByProvider('service-database').withProvider).toEqual([]);
		});
	});
});
