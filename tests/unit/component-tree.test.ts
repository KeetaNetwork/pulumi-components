import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { expectDefined, expectRecord } from '../helpers/narrow';
import { captureTree, describeTree, matchLegacyUrns, readBaselineCase, urnsOf, useIsolatedHome } from './harness/pulumi-tree';
import type { TreeResource, TreeSnapshot } from './harness/pulumi-tree';
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
const baseline: unknown = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

const BASELINE_PREFIX = 'urn:pulumi:stack::project::';

/** The URN a resource had in the released version, from its type chain and name */
function baselineUrn(typeChain: string, name: string) {
	return(`${BASELINE_PREFIX}${typeChain}::${name}`);
}

/*
 * URNs of the released version that this branch deliberately no longer
 * answers to, per case. The reason says what is dropped and why, for
 * example 'build provider removed'. The table is
 * empty until a phase drops a URN on purpose. An entry that is still
 * matched fails the test, so entries cannot go stale.
 */
const PLANNED_EXCEPTIONS: {
	expectedRemovals: { [caseName: string]: { [urn: string]: string }};
	deferredParents: { [nameEnding: string]: string };
} = {
	expectedRemovals: {
		'service-build-remote': {
			[baselineUrn('Keeta:GCP:CloudRunService$pulumi:providers:gcp', 'service-build-remote-build-provider')]: 'P7: build provider removed'
		},
		'service-providers': {
			[baselineUrn('Keeta:GCP:CloudRunService$pulumi:providers:gcp', 'service-providers-build-provider')]: 'P7: build provider removed'
		}
	},
	deferredParents: {
		'-subnet': 'P10: the network chain moves to AppNetwork',
		'-vpc-connector': 'P10: the network chain moves to AppNetwork',
		'-private-ip-alloc': 'P10: the network chain moves to AppNetwork',
		'-svc-networking': 'P10: the network chain moves to AppNetwork',
		'-kv-firewall': 'P10: the network chain moves to AppNetwork',
		'-ssh-iap-firewall': 'P10: the network chain moves to AppNetwork'
	}
};

/** Resources that the caller of a component creates and passes in: the library never re-parents or re-names them */
const CALLER_RESOURCES: { [caseName: string]: string[] } = {
	'service-caller-resources': [ 'caller-network', 'caller-account' ],
	'service-providers': [ 'caller-provider' ],
	'postgres-peering': [ 'postgres-network' ],
	'standalone-mig': [ 'standalone-mig-network', 'standalone-mig-subnet' ],
	'standalone-container-cloud-run': [ 'standalone-crwp-network', 'standalone-crwp-subnet' ]
};

/*
 * The resources that P7 moves to the component that owns them (Design P7,
 * "Moves in P7"). The IAM grants (P8) and the network chain (P10) are not
 * here. A resource that matches a row must have a component of one of the
 * `parents` types as its parent, named as the prefix of its own name, and
 * exactly one alias: its URN in the released version.
 */
interface Move {
	type: string;
	name: RegExp;
	parents: string[];
}

const STATIC_APP = 'Keeta:GCP:StaticWebApp';
const FRONT_ENDS = [ STATIC_APP, 'Keeta:GCP:FullStackApp' ];
const SERVICE = 'Keeta:GCP:CloudRunService';
const DATABASE = 'Keeta:GCP:PostgresCloudSQL';
const ENV_MANAGER = 'Keeta:GCP:CloudRunEnvManager';

const MOVES: Move[] = [
	{ type: 'gcp:storage/bucket:Bucket', name: /-bucket$/, parents: [ STATIC_APP ] },
	{ type: 'gcp:storage/bucketIAMMember:BucketIAMMember', name: /-bucket-viewer$/, parents: [ STATIC_APP ] },
	{ type: 'keeta:synced-folder:GoogleCloudFolderWithArgs', name: /-files$/, parents: [ STATIC_APP ] },
	{ type: 'gcp:compute/backendBucket:BackendBucket', name: /-backend$/, parents: [ STATIC_APP ] },
	{ type: 'gcp:compute/uRLMap:URLMap', name: /-http-redirect$/, parents: FRONT_ENDS },
	{ type: 'gcp:compute/targetHttpProxy:TargetHttpProxy', name: /-http-proxy$/, parents: FRONT_ENDS },
	{ type: 'gcp:compute/globalForwardingRule:GlobalForwardingRule', name: /-http-fr-ipv[46]$/, parents: FRONT_ENDS },
	{ type: 'Keeta:GCP:DockerImage', name: /-image$/, parents: [ SERVICE ] },
	{ type: 'gcp:cloudrun/iamMember:IamMember', name: /-invoker$/, parents: [ SERVICE ] },
	{ type: 'gcp:compute/regionNetworkEndpointGroup:RegionNetworkEndpointGroup', name: /-neg$/, parents: [ SERVICE ] },
	{ type: 'gcp:compute/backendService:BackendService', name: /-backend$/, parents: [ SERVICE ] },
	{ type: 'pulumi-nodejs:dynamic:Resource', name: /-migration-exec$|^standalone-migration-exec$/, parents: [ 'Keeta:GCP:MigrationJob' ] },
	{ type: 'gcp:sql/database:Database', name: /-db$/, parents: [ DATABASE ] },
	{ type: 'gcp:sql/user:User', name: /-db-user$/, parents: [ DATABASE ] },
	{ type: 'gcp:sql/databaseInstance:DatabaseInstance', name: /-replica$/, parents: [ DATABASE ] },
	{ type: 'gcp:servicenetworking/connection:Connection', name: /-postgres-vpc-connection$/, parents: [ DATABASE ] },
	{ type: 'gcp:secretmanager/secretVersion:SecretVersion', name: /-version$/, parents: [ ENV_MANAGER ] },
	/* The binding of a secret the caller owns (`-non-managed-`) had the EnvManager as its parent in 1.0.95 and stays there */
	{ type: 'gcp:secretmanager/secretIamMember:SecretIamMember', name: /^(?!.*-non-managed-).*-iam-binding$/, parents: [ ENV_MANAGER ] }
];

function moveOf(resource: TreeResource) {
	return(MOVES.find(function(move) {
		return(move.type === resource.type && move.name.test(resource.name));
	}));
}

/*
 * Cleanup that a parent used to carry. `target` is the resource that the
 * resource is deleted with: its name is the resource's name without
 * `ending`, plus `targetEnding`.
 */
interface Cleanup {
	type: string;
	ending: string;
	/** Names that the rule does not apply to */
	except?: RegExp;
	targetType: string;
	targetEnding: string;
}

const DELETED_WITH: Cleanup[] = [
	{ type: 'gcp:cloudrun/iamMember:IamMember', ending: '-invoker', targetType: 'gcp:cloudrun/service:Service', targetEnding: '-api' },
	{ type: 'gcp:compute/regionNetworkEndpointGroup:RegionNetworkEndpointGroup', ending: '-neg', targetType: 'gcp:cloudrun/service:Service', targetEnding: '-api' },
	{ type: 'gcp:storage/bucketIAMMember:BucketIAMMember', ending: '-bucket-viewer', targetType: 'gcp:storage/bucket:Bucket', targetEnding: '-bucket' },
	{ type: 'gcp:sql/database:Database', ending: '-db', targetType: 'gcp:sql/databaseInstance:DatabaseInstance', targetEnding: '-master' },
	{ type: 'gcp:sql/user:User', ending: '-db-user', targetType: 'gcp:sql/databaseInstance:DatabaseInstance', targetEnding: '-master' },
	{ type: 'gcp:secretmanager/secretVersion:SecretVersion', ending: '-version', targetType: 'gcp:secretmanager/secret:Secret', targetEnding: '' },
	{ type: 'gcp:secretmanager/secretIamMember:SecretIamMember', ending: '-iam-binding', except: /-non-managed-/, targetType: 'gcp:secretmanager/secret:Secret', targetEnding: '' }
];

/* [ case, resource, the resource it waits for ] */
const DEPENDS_ON: [ string, string, string ][] = [
	[ 'service-replicas', 'service-replicas-db-us-east1-replica', 'service-replicas-db-master' ],
	[ 'service-database', 'service-database-migration-exec', 'service-database-migration-job' ],
	[ 'service-providers', 'service-providers-migration-exec', 'service-providers-migration-job' ],
	[ 'standalone-migration-job', 'standalone-migration-exec', 'standalone-migration-job' ]
];

function parentOf(tree: TreeSnapshot, resource: TreeResource) {
	return(tree.resources.find(function(candidate) {
		return(candidate.urn === resource.parent);
	}));
}

function byName(tree: TreeSnapshot, name: string, type?: string) {
	return(tree.resources.find(function(candidate) {
		return(candidate.name === name && (type === undefined || candidate.type === type));
	}));
}

/** The one URN of the released version that has this resource's name and type as its own */
function releasedUrnOf(caseName: string, resource: TreeResource) {
	const matches = readBaselineCase(baseline, caseName).filter(function(urn) {
		const [ , , typeChain, name ] = urn.split('::');

		return(name === resource.name && typeChain?.split('$').pop() === resource.type);
	});

	return(matches);
}

/*
 * The aliases that move a resource: those that keep its type. The provider
 * SDK adds aliases of its own that change the type (for example for
 * serviceaccount.Account), which are not moves.
 */
function moveAliases(resource: TreeResource) {
	return(resource.aliases.filter(function(alias) {
		return(alias.split('::')[2]?.split('$').pop() === resource.type);
	}));
}

function isDeferred(resource: TreeResource) {
	return(Object.keys(PLANNED_EXCEPTIONS.deferredParents).some(function(ending) {
		return(resource.name.endsWith(ending));
	}));
}

function hasPlainParent(tree: TreeSnapshot, resource: TreeResource) {
	return(parentOf(tree, resource)?.custom === true);
}


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
		it('are recorded for exactly the cases of this file', function() {
			const recorded = Object.keys(expectRecord(expectRecord(baseline, 'the baseline').cases, 'the cases of the baseline')).sort();

			expect(recorded).toEqual([ ...caseNames ].sort());
		});

		it.each(caseNames)('%s still answers to every one, each exactly once', async function(caseName) {
			const planned = Object.keys(PLANNED_EXCEPTIONS.expectedRemovals[caseName] ?? {});
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
	 * A parent is the component that owns the lifecycle of a resource, never a
	 * plain resource: ordering goes in `dependsOn` and cleanup in `deletedWith`.
	 */
	describe('parenting', function() {
		it.each(caseNames)('%s has no plain resource as a parent, except the deferred ones', function(caseName) {
			const tree = treeOf(caseName);
			const offenders = tree.resources.filter(function(resource) {
				return(hasPlainParent(tree, resource) && !isDeferred(resource));
			}).map(function(resource) {
				return(`${resource.name} <- ${parentOf(tree, resource)?.name ?? 'none'}`);
			});

			expect(offenders).toEqual([]);
		});

		it.each(Object.entries(PLANNED_EXCEPTIONS.deferredParents))('keeps the deferred parent of *%s only while a resource needs it', function(ending, reason) {
			const needed = caseNames.some(function(caseName) {
				const tree = treeOf(caseName);

				return(tree.resources.some(function(resource) {
					return(resource.name.endsWith(ending) && hasPlainParent(tree, resource));
				}));
			});

			expect(reason).toMatch(/^P\d+: /);
			expect(needed).toBe(true);
		});

		it.each(caseNames)('%s puts every resource under its component, except what the caller passed in', function(caseName) {
			const tree = treeOf(caseName);
			const passedIn = CALLER_RESOURCES[caseName] ?? [];
			const roots = tree.resources.filter(function(resource) {
				return(resource.parent === undefined && !passedIn.includes(resource.name));
			});
			const strays = roots.filter(function(resource) {
				return(roots.some(function(other) {
					return(other !== resource && resource.name.startsWith(`${other.name}-`));
				}));
			});

			expect(strays.map(function(resource) {
				return(resource.name);
			})).toEqual([]);
		});

		it.each(Object.entries(CALLER_RESOURCES).flatMap(function([ caseName, names ]) {
			return(names.map(function(name): [ string, string ] {
				return([ caseName, name ]);
			}));
		}))('%s: leaves %s where the caller put it', function(caseName, name) {
			const tree = treeOf(caseName);
			const resource = expectDefined(byName(tree, name), `the resource ${name}`);

			expect(resource.parent).toBeUndefined();
			expect(moveAliases(resource)).toEqual([]);
			expect(readBaselineCase(baseline, caseName)).toContain(resource.urn);
		});

		it.each(Object.entries(PLANNED_EXCEPTIONS.expectedRemovals).flatMap(function([ caseName, urns ]) {
			return(Object.entries(urns).map(function([ urn, reason ]): [ string, string, string ] {
				return([ caseName, urn, reason ]);
			}));
		}))('%s: names the phase that removes %s', function(_caseName, _urn, reason) {
			expect(reason).toMatch(/^P\d+: /);
		});

		it('keeps the binding of a secret the caller owns where it was', function() {
			const tree = treeOf('service-environment');
			const binding = expectDefined(byName(tree, 'service-environment-env-non-managed-existing-iam-binding'), 'the binding of the existing secret');

			expect(readBaselineCase(baseline, 'service-environment')).toContain(binding.urn);
			expect(moveAliases(binding)).toEqual([]);
			expect(byName(tree, 'service-environment-env-non-managed-existing', 'gcp:secretmanager/secret:Secret')).toBeUndefined();
		});

		it('has a resource for every move of the table', function() {
			const unused = MOVES.filter(function(move) {
				return(!caseNames.some(function(caseName) {
					return(treeOf(caseName).resources.some(function(resource) {
						return(moveOf(resource) === move);
					}));
				}));
			});

			expect(unused).toEqual([]);
		});

		it.each(caseNames)('%s moves each resource to the component that owns it', function(caseName) {
			const tree = treeOf(caseName);
			const problems: string[] = [];
			for (const resource of tree.resources) {
				const move = moveOf(resource);
				const parent = parentOf(tree, resource);
				if (move === undefined) {
					continue;
				}

				if (parent === undefined || !move.parents.includes(parent.type) || !resource.name.startsWith(`${parent.name}-`)) {
					problems.push(`${resource.name} has the parent ${parent?.name ?? 'none'} (${parent?.type ?? 'none'}), expected a ${move.parents.join(' or ')} that its name starts with`);
				}
			}

			expect(problems).toEqual([]);
		});

		it.each(caseNames)('%s gives each moved resource one alias: its URN in 1.0.95', function(caseName) {
			const tree = treeOf(caseName);
			const problems: string[] = [];
			for (const resource of tree.resources) {
				if (moveOf(resource) === undefined) {
					continue;
				}

				const released = releasedUrnOf(caseName, resource);
				if (released.length !== 1 || JSON.stringify(moveAliases(resource)) !== JSON.stringify(released)) {
					problems.push(`${resource.name} has the aliases ${JSON.stringify(moveAliases(resource))}, expected ${JSON.stringify(released)}`);
				}
			}

			expect(problems).toEqual([]);
		});

		it.each(caseNames)('%s gives an alias to nothing that did not move', function(caseName) {
			const withAlias = treeOf(caseName).resources.filter(function(resource) {
				return(moveAliases(resource).length > 0 && moveOf(resource) === undefined);
			});

			expect(withAlias.map(function(resource) {
				return(resource.name);
			})).toEqual([]);
		});

		it.each(caseNames)('%s never aliases a resource to its own URN or to an old parent it did not have', function(caseName) {
			const tree = treeOf(caseName);
			const bad = tree.resources.filter(function(resource) {
				return(moveAliases(resource).length > 1 || resource.aliases.includes(resource.urn) || moveAliases(resource).some(function(alias) {
					return(!readBaselineCase(baseline, caseName).includes(alias));
				}));
			});

			expect(bad.map(function(resource) {
				return(resource.name);
			})).toEqual([]);
		});

		it.each(caseNames)('%s keeps cleanup in deletedWith', function(caseName) {
			const tree = treeOf(caseName);
			const problems: string[] = [];
			for (const resource of tree.resources) {
				const rule = DELETED_WITH.find(function(candidate) {
					return(candidate.type === resource.type && resource.name.endsWith(candidate.ending) && !candidate.except?.test(resource.name));
				});
				if (rule === undefined) {
					continue;
				}

				const targetName = resource.name.slice(0, resource.name.length - rule.ending.length) + rule.targetEnding;
				const target = byName(tree, targetName, rule.targetType);
				if (target === undefined || resource.deletedWith !== target.urn) {
					problems.push(`${resource.name} is deleted with ${resource.deletedWith ?? 'nothing'}, expected ${targetName}`);
				}
			}

			expect(problems).toEqual([]);
		});

		it.each(DEPENDS_ON)('%s: %s waits for %s', function(caseName, name, waitsFor) {
			const tree = treeOf(caseName);
			const resource = expectDefined(byName(tree, name), `the resource ${name}`);
			const target = expectDefined(byName(tree, waitsFor), `the resource ${waitsFor}`);

			expect(resource.dependsOn).toContain(target.urn);
		});
	});

	/*
	 * Pulumi hands `providers` down to the children that have the component
	 * as an ancestor. Every resource of a component is a descendant of it
	 * after P7, so a provider that the caller passes reaches all of them,
	 * including the docker image with its IAM grants and the remote build's
	 * service account and bucket. The first test keeps the snapshot of P2.
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

		it('gives the passed provider to the resources of the docker image', function() {
			const { withProvider } = gcpNamesByProvider('service-providers');
			const imageResources = [ 'iam-bucket', 'iam-logs', 'iam-builds', 'iam-serviceAgent' ].map(function(suffix) {
				return(`service-providers-image-${suffix}`);
			});

			expect(withProvider).toEqual(expect.arrayContaining([ ...imageResources, 'service-providers-api', 'service-providers-vpc', 'service-providers-db-master', 'service-providers-build-sa' ]));
		});

		it('leaves no gcp resource of the component on the default provider', function() {
			expect(gcpNamesByProvider('service-providers').withoutProvider).toEqual([]);
		});

		it('gives every gcp resource the provider that the caller created, and no other', function() {
			const tree = treeOf('service-providers');
			const passed = expectDefined(byName(tree, 'caller-provider'), 'the provider of the caller');
			const providers = tree.resources.filter(function(resource) {
				return(resource.type === 'pulumi:providers:gcp');
			}).map(function(resource) {
				return(resource.name);
			});
			const others = tree.resources.filter(function(resource) {
				return(resource.custom && resource.type.startsWith('gcp:') && resource.provider !== passed.urn);
			}).map(function(resource) {
				return(resource.name);
			});

			expect(providers).toEqual([ 'caller-provider' ]);
			expect(others).toEqual([]);
		});

		it('creates no provider of its own for a remote build', function() {
			const providers = treeOf('service-build-remote').resources.filter(function(resource) {
				return(resource.type === 'pulumi:providers:gcp');
			});

			expect(providers).toEqual([]);
		});

		/* The project of a build's IAM grants comes from the provider that getRemoteConfig hands to the docker image */
		it.each([ 'service-build-remote', 'service-providers' ])('%s: keeps the project of the build grants', function(caseName) {
			const tree = treeOf(caseName);
			const grants = tree.resources.filter(function(resource) {
				return(/-image-iam-(logs|builds|serviceAgent)$/.test(resource.name));
			});

			expect(grants).toHaveLength(3);
			expect(grants.map(function(resource) {
				return(expectRecord(resource.inputs, `the inputs of ${resource.name}`).project);
			})).toEqual([ 'project-id', 'project-id', 'project-id' ]);
		});

		it('uses the default provider everywhere when none is passed', function() {
			expect(gcpNamesByProvider('service-database').withProvider).toEqual([]);
		});
	});
});
