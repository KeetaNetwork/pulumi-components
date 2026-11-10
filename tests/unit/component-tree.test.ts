import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { expectDefined, expectRecord, optionalRecord } from '../helpers/narrow';
import { captureTree, describeTree, matchLegacyUrns, moveAliases, ofType, readBaselineCase, urnsOf, useIsolatedHome } from './harness/pulumi-tree';
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
 * The one table of planned exceptions. A reason says what the exception
 * does, for example 'build provider removed'.
 *
 * - `expectedRemovals`: per case, URNs of the released version that this
 *   branch deliberately no longer answers to. An entry that is still matched
 *   fails the test, so entries cannot go stale.
 *
 * There is no `deferredParents` table: the network chain has a component
 * parent (AppNetwork), so no resource is excused from the parent check.
 */
/**
 * The URNs that a duplicate environment had in the released version: its
 * manager, and for each secret variable the secret, its version and its
 * binding. The worker and the migration job read the environment of the app
 * from this release on, so these leave (a one-time rollout).
 */
function duplicateEnvironment(parentChain: string, manager: string, variables: string[]) {
	const reason = 'the worker and the migration job read the environment of the app';
	const environment = `${parentChain}$Keeta:GCP:CloudRunEnvManager`;
	const secret = `${environment}$gcp:secretmanager/secret:Secret`;
	const removed: { [urn: string]: string } = { [baselineUrn(environment, manager)]: reason };
	for (const variable of variables) {
		removed[baselineUrn(secret, `${manager}-${variable}`)] = reason;
		removed[baselineUrn(`${secret}$gcp:secretmanager/secretVersion:SecretVersion`, `${manager}-${variable}-version`)] = reason;
		removed[baselineUrn(`${secret}$gcp:secretmanager/secretIamMember:SecretIamMember`, `${manager}-${variable}-iam-binding`)] = reason;
	}

	return(removed);
}

const DATABASE_SECRETS = [ 'mc-psql-db-password', 'mc-psql-db-url' ];

const PLANNED_EXCEPTIONS: {
	expectedRemovals: { [caseName: string]: { [urn: string]: string }};
	/** Resources that keep a plain resource as their parent, by name */
	plainParents: { [caseName: string]: { [name: string]: string }};
} = {
	plainParents: {
		'internal-load-balancer': Object.fromEntries([ '-cert', '-map', '-target', '-ilb', '-ilb-in', '-ilb-in-health' ].map(function(ending) {
			return([ `internal-load-balancer${ending}`, 'not moved: the internal load balancer is outside the move' ]);
		}))
	},
	expectedRemovals: {
		'service-build-remote': {
			[baselineUrn('Keeta:GCP:CloudRunService$pulumi:providers:gcp', 'service-build-remote-build-provider')]: 'build provider removed'
		},
		'service-providers': {
			[baselineUrn('Keeta:GCP:CloudRunService$pulumi:providers:gcp', 'service-providers-build-provider')]: 'build provider removed',
			...duplicateEnvironment('Keeta:GCP:CloudRunService', 'service-providers-mig-env', [ ...DATABASE_SECRETS, 'secret' ]),
			...duplicateEnvironment('Keeta:GCP:CloudRunService$Keeta:GCP:MigrationJob', 'service-providers-migration-env', [ ...DATABASE_SECRETS, 'secret' ])
		},
		'service-database': duplicateEnvironment('Keeta:GCP:CloudRunService$Keeta:GCP:MigrationJob', 'service-database-migration-env', DATABASE_SECRETS),
		'service-mig': duplicateEnvironment('Keeta:GCP:CloudRunService', 'service-mig-mig-env', []),
		'service-crwp': duplicateEnvironment('Keeta:GCP:CloudRunService', 'service-crwp-mig-env', [])
	}
};

/** Resources that the caller of a component creates and passes in: the library never re-parents or re-names them */
const CALLER_RESOURCES: { [caseName: string]: string[] } = {
	'service-caller-resources': [ 'caller-network', 'caller-account' ],
	'service-providers': [ 'caller-provider' ],
	'postgres-peering': [ 'postgres-network' ],
	'standalone-mig': [ 'standalone-mig-network', 'standalone-mig-subnet' ],
	'standalone-container-cloud-run': [ 'standalone-crwp-network', 'standalone-crwp-subnet' ],
	'external-load-balancer': [ 'external-load-balancer-health' ],
	'external-load-balancer-mig': [ 'external-load-balancer-mig-worker', 'external-load-balancer-mig-cert', 'external-load-balancer-mig-health', 'external-load-balancer-mig-worker-network', 'external-load-balancer-mig-worker-subnet' ],
	'internal-load-balancer': [ 'internal-load-balancer-worker', 'internal-load-balancer-health', 'internal-load-balancer-worker-network', 'internal-load-balancer-worker-subnet' ]
};

/*
 * The resources that move to the component that owns them, then the IAM
 * grants and the network chain. A resource that matches a row must have a component of one of the
 * `parents` types as its parent, named as the prefix of its own name, and
 * exactly one alias: its URN in the released version.
 */
interface Move {
	type: string;
	name: RegExp;
	parents: string[];
	/** The type of the 1.0.95 parent, for a row that applies only to resources that had a parent of that type */
	oldParent?: string;
	/** The ending of the parent's name when the parent is not named after its children (`${app}-identity` owns `${app}-sa`) */
	parentSuffix?: string;
}

const STATIC_APP = 'Keeta:GCP:StaticWebApp';
const FRONT_ENDS = [ STATIC_APP, 'Keeta:GCP:FullStackApp' ];
const SERVICE = 'Keeta:GCP:CloudRunService';
const DATABASE = 'Keeta:GCP:PostgresCloudSQL';
const ENV_MANAGER = 'Keeta:GCP:CloudRunEnvManager';
const IDENTITY = 'Keeta:GCP:ServiceIdentity';
const APP_NETWORK = 'Keeta:GCP:AppNetwork';
const NETWORK = 'gcp:compute/network:Network';
const SUBNETWORK = 'gcp:compute/subnetwork:Subnetwork';
const EXTERNAL_LB = 'keeta:lb:ExternalLoadBalancer';
const INTERNAL_LB = 'keeta:lb:InternalLoadBalancer';
const URL_MAP = 'gcp:compute/uRLMap:URLMap';
const FORWARDING_RULE = 'gcp:compute/globalForwardingRule:GlobalForwardingRule';
const CERTIFICATE_MAP = 'gcp:certificatemanager/certificateMap:CertificateMap';
const SECURITY_POLICY = 'gcp:compute/securityPolicy:SecurityPolicy';
const SSL_POLICY = 'gcp:compute/sSLPolicy:SSLPolicy';
const HTTPS_PROXY = 'gcp:compute/targetHttpsProxy:TargetHttpsProxy';
/** What the HTTP redirect of a front end belongs to: the app, or the ExternalLoadBalancer (it was under the URL map) */
const REDIRECT_OWNERS = [ ...FRONT_ENDS, EXTERNAL_LB ];

const MOVES: Move[] = [
	{ type: 'gcp:storage/bucket:Bucket', name: /-bucket$/, parents: [ STATIC_APP ] },
	{ type: 'gcp:storage/bucketIAMMember:BucketIAMMember', name: /-bucket-viewer$/, parents: [ STATIC_APP ] },
	{ type: 'keeta:synced-folder:GoogleCloudFolderWithArgs', name: /-files$/, parents: [ STATIC_APP ] },
	{ type: 'gcp:compute/backendBucket:BackendBucket', name: /-backend$/, parents: [ STATIC_APP ] },
	{ type: URL_MAP, name: /-http-redirect$/, parents: REDIRECT_OWNERS },
	{ type: 'gcp:compute/targetHttpProxy:TargetHttpProxy', name: /-http-proxy$/, parents: REDIRECT_OWNERS },
	{ type: FORWARDING_RULE, name: /-http-fr(-ipv[46])?$/, parents: REDIRECT_OWNERS },
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
	/*
	 * The service account and the project roles of an app move to its
	 * ServiceIdentity. The migration job's own grant, the build service
	 * account (`-build-sa`) and the standalone components' accounts had
	 * another parent in 1.0.95 and stay where they are.
	 */
	{ type: 'gcp:serviceaccount/account:Account', name: /^(?!.*-build-sa$).*-sa$/, parents: [ IDENTITY ], oldParent: SERVICE, parentSuffix: '-identity' },
	{ type: 'gcp:projects/iAMMember:IAMMember', name: /-log-writer$/, parents: [ IDENTITY ], oldParent: SERVICE, parentSuffix: '-identity' },
	{ type: 'gcp:projects/iAMMember:IAMMember', name: /-cloudsql-client$/, parents: [ IDENTITY ], oldParent: DATABASE, parentSuffix: '-identity' },
	/*
	 * The network chain moves to the AppNetwork of the app. The old
	 * parent was the app's own network or the one the caller passed (the
	 * subnet and the firewall), the subnet (the connector) or the address
	 * (the peering), so each row names the type of the old parent. The
	 * subnets that standalone components get from their caller had none.
	 */
	{ type: 'gcp:compute/network:Network', name: /-vpc$/, parents: [ APP_NETWORK ], oldParent: SERVICE, parentSuffix: '-network' },
	{ type: 'gcp:compute/subnetwork:Subnetwork', name: /-subnet$/, parents: [ APP_NETWORK ], oldParent: NETWORK, parentSuffix: '-network' },
	{ type: 'gcp:vpcaccess/connector:Connector', name: /-vpc-connector$/, parents: [ APP_NETWORK ], oldParent: SUBNETWORK, parentSuffix: '-network' },
	{ type: 'gcp:compute/globalAddress:GlobalAddress', name: /-private-ip-alloc$/, parents: [ APP_NETWORK ], oldParent: NETWORK, parentSuffix: '-network' },
	{ type: 'gcp:servicenetworking/connection:Connection', name: /-svc-networking$/, parents: [ APP_NETWORK ], oldParent: 'gcp:compute/globalAddress:GlobalAddress', parentSuffix: '-network' },
	{ type: 'gcp:compute/firewall:Firewall', name: /-ssh-iap-firewall$/, parents: [ APP_NETWORK ], oldParent: NETWORK, parentSuffix: '-network' },
	{ type: 'gcp:compute/firewall:Firewall', name: /-kv-firewall$/, parents: [ APP_NETWORK ], oldParent: NETWORK, parentSuffix: '-network' },
	/*
	 * What ExternalLoadBalancer put under its own URL map, backend
	 * service or forwarding rule moves to the component (the redirect rows
	 * above cover its HTTP redirect). Each row names the type of the old
	 * parent. InternalLoadBalancer moves nothing.
	 */
	{ type: URL_MAP, name: /-ext-map$/, parents: [ EXTERNAL_LB ], oldParent: 'gcp:compute/backendService:BackendService' },
	{ type: CERTIFICATE_MAP, name: /-ext-cert-map$/, parents: [ EXTERNAL_LB ], oldParent: URL_MAP },
	{ type: 'gcp:certificatemanager/certificateMapEntry:CertificateMapEntry', name: /-ext-cert-map-entry$/, parents: [ EXTERNAL_LB ], oldParent: CERTIFICATE_MAP },
	{ type: HTTPS_PROXY, name: /-ext-target$/, parents: [ EXTERNAL_LB ], oldParent: URL_MAP },
	{ type: FORWARDING_RULE, name: /-lb$/, parents: [ EXTERNAL_LB ], oldParent: URL_MAP },
	{ type: 'gcp:compute/firewall:Firewall', name: /-lb-in$/, parents: [ EXTERNAL_LB ], oldParent: FORWARDING_RULE },
	{ type: 'gcp:compute/globalNetworkEndpoint:GlobalNetworkEndpoint', name: /-ext-be-ne$/, parents: [ EXTERNAL_LB ], oldParent: 'gcp:compute/globalNetworkEndpointGroup:GlobalNetworkEndpointGroup' },
	/* The binding of a secret the caller owns (`-non-managed-`) had the EnvManager as its parent in 1.0.95 and stays there */
	{ type: 'gcp:secretmanager/secretIamMember:SecretIamMember', name: /^(?!.*-non-managed-).*-iam-binding$/, parents: [ ENV_MANAGER ] }
];

/** A resource that kept its parent and got another logical name; it has one alias, to its URN under the old name */
interface Rename {
	caseName: string;
	type: string;
	parent: string;
	from: string;
	to: string;
}

const RENAMES: Rename[] = [
	{ caseName: 'internal-load-balancer', type: SECURITY_POLICY, parent: INTERNAL_LB, from: 'internal-load-balancer-ext-be-sp', to: 'internal-load-balancer-int-be-sp' }
];

function isRenamed(caseName: string, resource: TreeResource) {
	return(RENAMES.some(function(rename) {
		return(rename.caseName === caseName && rename.type === resource.type && rename.to === resource.name);
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

function moveOf(caseName: string, resource: TreeResource) {
	return(MOVES.find(function(move) {
		if (move.type !== resource.type || !move.name.test(resource.name)) {
			return(false);
		}

		if (move.oldParent === undefined) {
			return(true);
		}

		/* The type chain of the one URN the resource had, without its own type, ends with the type of its old parent */
		const [ released ] = releasedUrnOf(caseName, resource);
		const chain = released?.split('::')[2]?.split('$') ?? [];

		return(chain[chain.length - 2] === move.oldParent);
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

/** The parent's name is the resource's prefix, once the ending that the parent adds to its owner's name is taken off */
function isNamedAfter(parent: TreeResource, resource: TreeResource, suffix: string) {
	return(parent.name.endsWith(suffix) && resource.name.startsWith(`${parent.name.slice(0, parent.name.length - suffix.length)}-`));
}

function hasPlainParent(tree: TreeSnapshot, resource: TreeResource) {
	return(parentOf(tree, resource)?.custom === true);
}


const PROJECT_GRANT = 'gcp:projects/iAMMember:IAMMember';

/** The components whose project grants an app's ServiceIdentity now owns */
const GRANTING_COMPONENTS = [ 'Keeta:GCP:MigrationJob', 'Keeta:GCP:ContainerMIG', 'Keeta:GCP:ContainerCloudRun' ];

function childrenOf(tree: TreeSnapshot, parent: TreeResource) {
	return(tree.resources.filter(function(resource) {
		return(resource.parent === parent.urn);
	}));
}

function appsOf(tree: TreeSnapshot) {
	return(tree.resources.filter(function(resource) {
		return(resource.type === SERVICE);
	}));
}

/** What identifies a project grant in GCP: the same triple granted twice is one binding */
function grantKey(resource: TreeResource) {
	const inputs = expectRecord(resource.inputs, `the inputs of ${resource.name}`);

	return(JSON.stringify([ inputs.project, inputs.role, inputs.member ]));
}

/** The project grants of a tree that a later `pulumi destroy` would revoke */
function liveGrants(tree: TreeSnapshot) {
	return(tree.resources.filter(function(resource) {
		return(resource.type === PROJECT_GRANT && resource.retainOnDelete !== true);
	}));
}

function ancestorTypes(tree: TreeSnapshot, resource: TreeResource) {
	const types: string[] = [];
	let current = parentOf(tree, resource);
	while (current !== undefined) {
		types.push(current.type);
		current = parentOf(tree, current);
	}

	return(types);
}

/** The app (CloudRunService) that a resource is part of, if any */
function appOf(tree: TreeSnapshot, resource: TreeResource) {
	let current = parentOf(tree, resource);
	while (current !== undefined) {
		if (current.type === SERVICE) {
			return(current);
		}

		current = parentOf(tree, current);
	}

	return(undefined);
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
				'Keeta:Crypto:ECDSAKeyPair',
				'Keeta:GCP:AppNetwork',
				'Keeta:GCP:CloudRunEnvManager',
				'Keeta:GCP:CloudRunService',
				'Keeta:GCP:ContainerCloudRun',
				'Keeta:GCP:ContainerMIG',
				'Keeta:GCP:DockerImage',
				'Keeta:GCP:FullStackApp',
				'Keeta:GCP:MigrationJob',
				'Keeta:GCP:PostgresCloudSQL',
				'Keeta:GCP:ServiceIdentity',
				'Keeta:GCP:StaticWebApp',
				'keeta:lb:ExternalLoadBalancer',
				'keeta:lb:InternalLoadBalancer',
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
		it.each(caseNames)('%s has no plain resource as a parent', function(caseName) {
			const tree = treeOf(caseName);
			const offenders = tree.resources.filter(function(resource) {
				return(hasPlainParent(tree, resource) && PLANNED_EXCEPTIONS.plainParents[caseName]?.[resource.name] === undefined);
			}).map(function(resource) {
				return(`${resource.name} <- ${parentOf(tree, resource)?.name ?? 'none'}`);
			});

			expect(offenders).toEqual([]);
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
		}))('%s: gives a reason for removing %s', function(_caseName, _urn, reason) {
			expect(reason).toMatch(/^\S+ \S+/);
		});

		it.each(Object.entries(PLANNED_EXCEPTIONS.plainParents).flatMap(function([ caseName, names ]) {
			return(Object.entries(names).map(function([ name, reason ]): [ string, string, string ] {
				return([ caseName, name, reason ]);
			}));
		}))('%s: keeps the plain parent of %s only for a reason, and only while it has one', function(caseName, name, reason) {
			const tree = treeOf(caseName);
			const resource = expectDefined(byName(tree, name), `the resource ${name}`);

			expect(reason).toMatch(/^\S+ \S+/);
			expect(hasPlainParent(tree, resource)).toBe(true);
			expect(moveAliases(resource)).toEqual([]);
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
						return(moveOf(caseName, resource) === move);
					}));
				}));
			});

			expect(unused).toEqual([]);
		});

		it.each(caseNames)('%s moves each resource to the component that owns it', function(caseName) {
			const tree = treeOf(caseName);
			const problems: string[] = [];
			for (const resource of tree.resources) {
				const move = moveOf(caseName, resource);
				const parent = parentOf(tree, resource);
				if (move === undefined) {
					continue;
				}

				if (parent === undefined || !move.parents.includes(parent.type) || !isNamedAfter(parent, resource, move.parentSuffix ?? '')) {
					problems.push(`${resource.name} has the parent ${parent?.name ?? 'none'} (${parent?.type ?? 'none'}), expected a ${move.parents.join(' or ')} that its name starts with`);
				}
			}

			expect(problems).toEqual([]);
		});

		it.each(caseNames)('%s gives each moved resource one alias: its URN in 1.0.95', function(caseName) {
			const tree = treeOf(caseName);
			const problems: string[] = [];
			for (const resource of tree.resources) {
				if (moveOf(caseName, resource) === undefined) {
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
				return(moveAliases(resource).length > 0 && moveOf(caseName, resource) === undefined && !isRenamed(caseName, resource));
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
	 * One owner per project role: the
	 * ServiceIdentity of an app grants the project roles of its service
	 * account. A grant that a component made for itself before stays in the
	 * code as a retained tombstone at its old URN, so removing the duplicate
	 * never revokes the role a surviving binding still gives.
	 */
	describe('IAM ownership', function() {
		it.each(caseNames)('%s has no two live project grants with the same project, role and member', function(caseName) {
			const seen = new Map<string, string[]>();
			for (const grant of liveGrants(treeOf(caseName))) {
				seen.set(grantKey(grant), [ ...seen.get(grantKey(grant)) ?? [], grant.name ]);
			}

			const duplicates = [ ...seen.values() ].filter(function(names) {
				return(names.length > 1);
			});

			expect(duplicates).toEqual([]);
		});

		it.each(caseNames)('%s gives each app one ServiceIdentity, named after it, under it', function(caseName) {
			const tree = treeOf(caseName);
			const problems: string[] = [];
			for (const app of appsOf(tree)) {
				const identities = childrenOf(tree, app).filter(function(child) {
					return(child.type === IDENTITY);
				});
				if (identities.length !== 1 || identities[0]?.name !== `${app.name}-identity`) {
					problems.push(`${app.name} has the identities ${JSON.stringify(identities.map(function(identity) {
						return(identity.name);
					}))}`);
				}
			}

			expect(problems).toEqual([]);
		});

		/* The roles an app needs: the service account gets the log writer, the Cloud SQL client with a database and the metric writer with a worker */
		it.each(caseNames)('%s grants the project roles of each app through its ServiceIdentity, once each', function(caseName) {
			const tree = treeOf(caseName);
			const problems: string[] = [];
			for (const app of appsOf(tree)) {
				const children = childrenOf(tree, app);
				const identity = children.find(function(child) {
					return(child.type === IDENTITY);
				});
				const account = tree.resources.find(function(resource) {
					return(resource.name === `${app.name}-sa` && resource.type === 'gcp:serviceaccount/account:Account');
				});
				const expected: string[] = [];
				if (account !== undefined) {
					expected.push(`${app.name}-log-writer`);
					if (children.some(function(child) {
						return(child.type === DATABASE);
					})) {
						expected.push(`${app.name}-cloudsql-client`);
					}

					if (children.some(function(child) {
						return(GRANTING_COMPONENTS.includes(child.type) && child.type !== 'Keeta:GCP:MigrationJob');
					})) {
						expected.push(`${app.name}-metric-writer`);
					}
				}

				let owned: TreeResource[] = [];
				if (identity !== undefined) {
					owned = childrenOf(tree, identity).filter(function(child) {
						return(child.type === PROJECT_GRANT && child.retainOnDelete !== true);
					});
				}

				const onTheApp = liveGrants(tree).filter(function(grant) {
					return(ancestorTypes(tree, grant).includes(SERVICE) && !ancestorTypes(tree, grant).includes('Keeta:GCP:DockerImage') && grant.parent !== identity?.urn);
				});
				const actual = owned.map(function(grant) {
					return(grant.name);
				}).sort();

				if (JSON.stringify(actual) !== JSON.stringify([ ...expected ].sort()) || onTheApp.length > 0) {
					problems.push(`${app.name}: the identity owns ${JSON.stringify(actual)}, expected ${JSON.stringify([ ...expected ].sort())}; other live grants: ${JSON.stringify(onTheApp.map(function(grant) {
						return(grant.name);
					}))}`);
				}
			}

			expect(problems).toEqual([]);
		});

		/*
		 * The project grants of a migration job, a container MIG or a Cloud
		 * Run worker pool of an app are tombstones: they keep their URN (and
		 * so their state) and their binding in GCP, but are retained. A
		 * component used on its own still grants for itself, as today.
		 */
		it.each(caseNames)('%s keeps the superseded grants as retained tombstones at their old URN, and standalone components keep granting', function(caseName) {
			const tree = treeOf(caseName);
			const problems: string[] = [];
			for (const grant of tree.resources) {
				const parent = parentOf(tree, grant);
				if (grant.type !== PROJECT_GRANT || parent === undefined || !GRANTING_COMPONENTS.includes(parent.type)) {
					continue;
				}

				const ownedByApp = parentOf(tree, parent)?.type === SERVICE;
				if (ownedByApp && grant.retainOnDelete !== true) {
					problems.push(`${grant.name} is not retained`);
				}

				if (ownedByApp && (moveAliases(grant).length > 0 || !readBaselineCase(baseline, caseName).includes(grant.urn))) {
					problems.push(`${grant.name} is not at its URN of 1.0.95`);
				}

				if (!ownedByApp && grant.retainOnDelete !== undefined) {
					problems.push(`${grant.name} is retained, but its component has no identity`);
				}
			}

			expect(problems).toEqual([]);
		});

		/* What the move of the grants must leave alone */
		it.each(caseNames)('%s leaves the registry grants and the secret versions as they are', function(caseName) {
			const tree = treeOf(caseName);
			const problems: string[] = [];
			for (const resource of tree.resources) {
				const inputs = optionalRecord(resource.inputs);
				if (resource.type === 'gcp:artifactregistry/repositoryIamMember:RepositoryIamMember' && (resource.retainOnDelete !== undefined || moveAliases(resource).length > 0)) {
					problems.push(`${resource.name} changed`);
				}

				if (resource.type === 'gcp:secretmanager/secretVersion:SecretVersion' && (inputs?.deletionPolicy !== 'DISABLE' || resource.retainOnDelete !== undefined)) {
					problems.push(`${resource.name} no longer has deletionPolicy DISABLE`);
				}
			}

			expect(problems).toEqual([]);
		});

		it('gives the passed provider to the resources of the ServiceIdentity', function() {
			const tree = treeOf('service-providers');
			const passed = expectDefined(byName(tree, 'caller-provider'), 'the provider of the caller');
			const identity = expectDefined(byName(tree, 'service-providers-identity', IDENTITY), 'the ServiceIdentity');
			const owned = childrenOf(tree, identity);

			expect(owned.map(function(resource) {
				return(resource.name);
			}).sort()).toEqual([ 'service-providers-cloudsql-client', 'service-providers-log-writer', 'service-providers-metric-writer', 'service-providers-sa' ]);
			expect(owned.filter(function(resource) {
				return(resource.provider !== passed.urn);
			})).toEqual([]);
		});
	});

	/*
	 * An app has one EnvManager, `${name}-env`, and its service, migration job
	 * and worker read views of it. The EnvManagers of the worker and of
	 * the migration job leave with their secrets: the one-time rollout that
	 * `PLANNED_EXCEPTIONS.expectedRemovals` names. A standalone MigrationJob
	 * keeps its own EnvManager.
	 */
	describe('environment ownership', function() {
		const ENVIRONMENT_TYPES = [
			ENV_MANAGER,
			'gcp:secretmanager/secret:Secret',
			'gcp:secretmanager/secretVersion:SecretVersion',
			'gcp:secretmanager/secretIamMember:SecretIamMember'
		];
		const RUNNERS = [ 'gcp:cloudrun/service:Service', 'gcp:cloudrunv2/job:Job', 'gcp:cloudrunv2/workerPool:WorkerPool' ];

		/** The names that the secret references in a value point at (`secretKeyRef.name` of a service, `.secret` of a job) */
		function secretNamesOf(value: unknown): string[] {
			if (Array.isArray(value)) {
				const items: unknown[] = value;

				return(items.flatMap(secretNamesOf));
			}

			const record = optionalRecord(value);
			if (record === undefined) {
				return([]);
			}

			const names: string[] = [];
			const reference = optionalRecord(record.secretKeyRef);
			for (const field of [ 'name', 'secret' ]) {
				const named = reference?.[field];
				if (typeof named === 'string') {
					names.push(named);
				}
			}

			for (const nested of Object.values(record)) {
				names.push(...secretNamesOf(nested));
			}

			return(names);
		}

		it.each(caseNames)('%s has one EnvManager for each app, named after it, under it', function(caseName) {
			const tree = treeOf(caseName);
			const offenders = tree.resources.filter(function(resource) {
				const app = appOf(tree, resource);
				if (resource.type !== ENV_MANAGER || app === undefined) {
					return(false);
				}

				return(parentOf(tree, resource)?.urn !== app.urn || resource.name !== `${app.name}-env`);
			});

			expect(offenders.map(function(resource) {
				return(resource.name);
			})).toEqual([]);
		});

		it.each(caseNames)('%s has one managed secret for each variable of an app', function(caseName) {
			const tree = treeOf(caseName);
			const offenders = tree.resources.filter(function(resource) {
				const app = appOf(tree, resource);
				if (!ENVIRONMENT_TYPES.includes(resource.type) || app === undefined) {
					return(false);
				}

				return(!resource.name.startsWith(`${app.name}-env`));
			});

			expect(offenders.map(function(resource) {
				return(resource.name);
			})).toEqual([]);
		});

		/*
		 * A removed secret must not be one that a service, a job or a worker
		 * still names: every reference points at a secret of the tree or at
		 * one that the caller owns (the binding of `-non-managed-` names it).
		 */
		it.each(caseNames)('%s reads only secrets that exist, and none of a removed environment', function(caseName) {
			const tree = treeOf(caseName);
			const known = tree.resources.filter(function(resource) {
				return(resource.type === 'gcp:secretmanager/secret:Secret' || resource.type === 'gcp:secretmanager/secretIamMember:SecretIamMember');
			}).map(function(resource) {
				return(optionalRecord(resource.inputs)?.secretId);
			});
			const references = tree.resources.filter(function(resource) {
				return(RUNNERS.includes(resource.type));
			}).map(function(resource): [ TreeResource, string[] ] {
				return([ resource, secretNamesOf(resource.inputs) ]);
			});
			const missing = references.flatMap(function([ resource, names ]) {
				return(names.filter(function(name) {
					return(!known.includes(name));
				}).map(function(name) {
					return(`${resource.name} -> ${name}`);
				}));
			});
			const removed = references.flatMap(function([ resource, names ]) {
				return(names.filter(function(name) {
					return(appOf(tree, resource) !== undefined && (name.includes('-mig-env-') || name.includes('-migration-env-')));
				}).map(function(name) {
					return(`${resource.name} -> ${name}`);
				}));
			});

			expect({ missing, removed }).toEqual({ missing: [], removed: [] });
		});
	});

	/*
	 * An app owns its network through an AppNetwork, `${name}-network`: the VPC it
	 * creates, the subnet, the connector, the peering and the IAP firewall are
	 * its children, and a network that the caller passed is
	 * never one of them. Two resources of the library leave: the EGRESS allow
	 * of the Redis firewall and the default route that the Cloud NAT of a
	 * worker pool added to the one every network has.
	 */
	describe('network ownership', function() {
		const NETWORK_ENDINGS = [ '-vpc', '-subnet', '-vpc-connector', '-private-ip-alloc', '-svc-networking', '-ssh-iap-firewall' ];
		const CONNECTION = 'gcp:servicenetworking/connection:Connection';

		function hasNetwork(tree: TreeSnapshot, app: TreeResource) {
			return(byName(tree, `${app.name}-subnet`, SUBNETWORK) !== undefined);
		}

		it.each(caseNames)('%s gives each app with a network one AppNetwork, named after it, under it, and the others none', function(caseName) {
			const tree = treeOf(caseName);
			const problems: string[] = [];
			for (const app of appsOf(tree)) {
				const networks = childrenOf(tree, app).filter(function(child) {
					return(child.type === APP_NETWORK);
				}).map(function(child) {
					return(child.name);
				});
				const expected: string[] = [];
				if (hasNetwork(tree, app)) {
					expected.push(`${app.name}-network`);
				}

				if (JSON.stringify(networks) !== JSON.stringify(expected)) {
					problems.push(`${app.name} has the networks ${JSON.stringify(networks)}, expected ${JSON.stringify(expected)}`);
				}
			}

			expect(problems).toEqual([]);
		});

		it.each(caseNames)('%s keeps the network resources of the library under an AppNetwork, never under the app or another resource', function(caseName) {
			const tree = treeOf(caseName);
			const offenders = tree.resources.filter(function(resource) {
				const owner = appOf(tree, resource);

				return(owner !== undefined && resource.parent !== undefined && NETWORK_ENDINGS.some(function(ending) {
					return(resource.name === `${owner.name}${ending}`);
				}) && parentOf(tree, resource)?.type !== APP_NETWORK);
			});

			expect(offenders.map(function(resource) {
				return(resource.name);
			})).toEqual([]);
		});

		it.each(caseNames)('%s has one servicenetworking connection for each AppNetwork that has a database, and none for the others', function(caseName) {
			const tree = treeOf(caseName);
			const problems: string[] = [];
			for (const network of tree.resources.filter(function(resource) {
				return(resource.type === APP_NETWORK);
			})) {
				const connections = childrenOf(tree, network).filter(function(child) {
					return(child.type === CONNECTION);
				});
				const wanted = childrenOf(tree, network).filter(function(child) {
					return(child.name.endsWith('-private-ip-alloc'));
				}).length;
				if (connections.length !== wanted) {
					problems.push(`${network.name} has ${connections.length} connections for ${wanted} reserved ranges`);
				}
			}

			expect(problems).toEqual([]);
		});

		it('does not adopt the network that the caller passed', function() {
			const tree = treeOf('service-caller-resources');
			const owned = childrenOf(tree, expectDefined(byName(tree, 'service-caller-resources-network', APP_NETWORK), 'the AppNetwork'));

			expect(owned.map(function(resource) {
				return(resource.type);
			})).not.toContain(NETWORK);
			expect(owned.map(function(resource) {
				return(resource.name);
			}).sort()).toEqual([ 'service-caller-resources-private-ip-alloc', 'service-caller-resources-subnet', 'service-caller-resources-svc-networking', 'service-caller-resources-vpc-connector' ]);
		});

		/*
		 * The route and the firewall that leave were redundant with what a
		 * network has (the default route to the internet gateway, the implied
		 * allow-all egress). The tree shows that nothing takes those away: no
		 * network deletes its default routes on creation, no route of the
		 * library replaces the default one, and no firewall of the library
		 * denies egress. The default route itself is made by GCP, so it is not
		 * a resource that a test can see.
		 */
		/* The one route is the default route that the Cloud Run worker pool's NAT keeps, as in 1.0.95 */
		it.each(caseNames)('%s creates no route but the NAT default route, no network without its default route and no egress deny', function(caseName) {
			const tree = treeOf(caseName);
			const offenders = tree.resources.filter(function(resource) {
				const inputs = optionalRecord(resource.inputs);
				const denies = inputs?.denies;
				if (resource.type === 'gcp:compute/route:Route') {
					return(!resource.name.endsWith('-nat-default-route'));
				}

				if (resource.type === NETWORK) {
					return(inputs?.deleteDefaultRoutesOnCreate === true);
				}

				return(resource.type === 'gcp:compute/firewall:Firewall' && inputs?.direction === 'EGRESS' && Array.isArray(denies) && denies.length > 0);
			});

			expect(offenders.map(function(resource) {
				return(resource.name);
			})).toEqual([]);
		});

		it('keeps the router and the NAT of the Cloud Run worker pool, the egress path that the default route serves', function() {
			const tree = treeOf('service-crwp');

			expect(tree.resources.filter(function(resource) {
				return(resource.type === 'gcp:compute/router:Router' || resource.type === 'gcp:compute/routerNat:RouterNat');
			}).map(function(resource) {
				return(resource.name);
			}).sort()).toEqual([ 'service-crwp-crwp-cloudnat', 'service-crwp-crwp-cloudnat-router' ]);
			expect(optionalRecord(byName(tree, 'service-crwp-vpc', NETWORK)?.inputs)?.autoCreateSubnetworks).toBe(false);
		});

		it.each([
			[ 'service-kv', '-kv-firewall' ],
			[ 'service-crwp', '-nat-default-route' ]
		])('%s keeps its %s and the rest of its network', function(caseName, suffix) {
			const names = treeOf(caseName).resources.map(function(resource) {
				return(resource.name);
			});

			expect(names.filter(function(name) {
				return(name.endsWith(suffix));
			})).toHaveLength(1);
			expect(names.filter(function(name) {
				return(name.endsWith('-vpc') || name.endsWith('-subnet') || name.endsWith('-vpc-connector'));
			}).length).toBeGreaterThanOrEqual(3);
		});
	});

	/*
	 * Pulumi hands `providers` down to the children that have the component
	 * as an ancestor. Every resource of a component is a descendant of it
	 * once they move to it, so a provider that the caller passes reaches all of them,
	 * including the docker image with its IAM grants and the remote build's
	 * service account and bucket. The first test keeps the snapshot of the released tree.
	 */
	/*
	 * Every HTTPS front end of the library gets one SSL
	 * policy of its own (`${name}-ssl-policy`), attached to its proxy. It is
	 * the only resource the release creates: no front end loses or replaces
	 * anything. InternalLoadBalancer is outside this table: it gets no policy.
	 */
	describe('SSL policy', function() {
		/* [ case, the proxy, the policy it is attached to ] */
		const PROXIES: [ string, string, string ][] = [
			[ 'static-web-app-load-balancer', 'static-web-app-lb-https-proxy', 'static-web-app-lb-ssl-policy' ],
			[ 'full-stack-app', 'full-stack-https-proxy', 'full-stack-ssl-policy' ],
			[ 'full-stack-app-without-frontend', 'full-stack-api-https-proxy', 'full-stack-api-ssl-policy' ],
			[ 'external-load-balancer', 'external-load-balancer-ext-target', 'external-load-balancer-ssl-policy' ],
			[ 'external-load-balancer-mig', 'external-load-balancer-mig-ext-target', 'external-load-balancer-mig-ssl-policy' ]
		];

		it.each(PROXIES)('%s: attaches the MODERN TLS 1.2 policy of its component to %s', function(caseName, proxyName, policyName) {
			const tree = treeOf(caseName);
			const proxy = expectDefined(byName(tree, proxyName, HTTPS_PROXY), `the proxy ${proxyName}`);
			const policy = expectDefined(byName(tree, policyName, SSL_POLICY), `the policy ${policyName}`);

			expect(ofType(tree, SSL_POLICY)).toHaveLength(1);
			expect(policy.parent).toBe(proxy.parent);
			expect(expectRecord(policy.inputs, `the inputs of ${policyName}`)).toMatchObject({ profile: 'MODERN', minTlsVersion: 'TLS_1_2' });
			expect(expectRecord(proxy.inputs, `the inputs of ${proxyName}`).sslPolicy).toBeTypeOf('string');
			expect(proxy.dependsOn).toContain(policy.urn);
		});

		it.each(PROXIES)('%s: creates no resource but the SSL policy of its front end', function(caseName, _proxyName, policyName) {
			const released = new Set(readBaselineCase(baseline, caseName).map(function(urn) {
				const [ , , typeChain, name ] = urn.split('::');

				return(`${typeChain?.split('$').pop() ?? ''}::${name ?? ''}`);
			}));
			const created = treeOf(caseName).resources.filter(function(resource) {
				return(resource.custom && !released.has(`${resource.type}::${resource.name}`));
			});

			expect(created.map(function(resource) {
				return(resource.name);
			})).toEqual([ policyName ]);
		});
	});

	/*
	 * The policy of InternalLoadBalancer is named after the
	 * internal balancer. Its parent stays, so one alias to the URN under the
	 * old name is all the move needs, and nothing is replaced.
	 */
	describe('renamed resources', function() {
		it.each(RENAMES)('$caseName: $from is now $to, with one alias to $from', function(rename) {
			const tree = treeOf(rename.caseName);
			const resource = expectDefined(byName(tree, rename.to, rename.type), `the resource ${rename.to}`);
			const parent = expectDefined(parentOf(tree, resource), `the parent of ${rename.to}`);
			const released = readBaselineCase(baseline, rename.caseName).filter(function(urn) {
				return(urn.endsWith(`::${rename.from}`) && urn.split('::')[2]?.split('$').pop() === rename.type);
			});

			expect(parent.type).toBe(rename.parent);
			expect(rename.to.startsWith(`${parent.name}-`)).toBe(true);
			expect(released).toHaveLength(1);
			expect(resource.aliases).toEqual(released);
			expect(byName(tree, rename.from)).toBeUndefined();
			expect(released[0]).toContain(`${parent.type}$${rename.type}::`);
		});

		it('keeps ExternalLoadBalancer on the name that it has had', function() {
			expect(byName(treeOf('external-load-balancer-mig'), 'external-load-balancer-mig-ext-be-sp', SECURITY_POLICY)).toBeDefined();
		});
	});

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
