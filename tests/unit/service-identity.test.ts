import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';
import { describe, expect, it } from 'vitest';

import type * as apps from '../../src/packages/gcp/apps';
import type { GCPCommonOptions } from '../../src/packages/gcp/common';
import type * as container from '../../src/packages/gcp/container';
import type * as identityModule from '../../src/packages/gcp/identity';
import type * as migration from '../../src/packages/gcp/migration';
import { expectRecord } from '../helpers/narrow';
import { requireSource } from './harness/load-sources';
import { captureTree, useIsolatedHome } from './harness/pulumi-tree';
import type { TreeResource, TreeSnapshot } from './harness/pulumi-tree';
import { workerSpec, workerSubnetwork } from './harness/tree-cases';
import { IMAGE, captureService } from './harness/service-builder';

const { ContainerCloudRun, ContainerMIG } = requireSource<typeof container>('src/packages/gcp/container.ts');
const { MigrationJob } = requireSource<typeof migration>('src/packages/gcp/migration.ts');

type ServiceArgs = ConstructorParameters<typeof apps.CloudRunService>[1];
type PolicyHook = GCPCommonOptions['changeProjectIAMPolicy'];
type IdentityRef = identityModule.ServiceIdentityRef;

const PROJECT_GRANT = 'gcp:projects/iAMMember:IAMMember';
const ACCOUNT = 'worker@project-id.iam.gserviceaccount.com';

const LOG_WRITER = 'roles/logging.logWriter';
const METRIC_WRITER = 'roles/monitoring.metricWriter';
const CLOUD_SQL_CLIENT = 'roles/cloudsql.client';

function grantsOf(resources: TreeResource[]) {
	return(resources.filter(function(resource) {
		return(resource.type === PROJECT_GRANT);
	}));
}

function liveGrantsOf(resources: TreeResource[]) {
	return(grantsOf(resources).filter(function(grant) {
		return(grant.retainOnDelete !== true);
	}));
}

function retainedGrantsOf(resources: TreeResource[]) {
	return(grantsOf(resources).filter(function(grant) {
		return(grant.retainOnDelete === true);
	}));
}

function roleOf(grant: TreeResource) {
	return(expectRecord(grant.inputs, `the inputs of ${grant.name}`).role);
}

function liveRolesOf(resources: TreeResource[]) {
	return(liveGrantsOf(resources).map(roleOf).sort());
}

/** `gcp` options of a component, with the hook only when there is one */
function gcpOptions(hook: PolicyHook) {
	if (hook === undefined) {
		return({ project: 'project-id' });
	}

	return({ project: 'project-id', changeProjectIAMPolicy: hook });
}

/** A hook that records the roles it is asked for and creates nothing */
function recordingHook(asked: string[]): PolicyHook {
	return(function(role) {
		asked.push(role);

		return(undefined);
	});
}

/** The URN that a resource of the app had in 1.0.95: the type chain of its parents, and its name */
function releasedUrn(tree: TreeSnapshot, typeChain: string, name: string) {
	return(`urn:pulumi:${tree.stack}::${tree.project}::${typeChain}::${name}`);
}

/*
 * The ServiceIdentity of an app grants the project roles of its service
 * account, once each (invariant I-iam-owner). When it does not grant a role
 * (the caller supplied the account, or `grantIAMRoles` is false), the worker
 * and the migration job grant their roles as in 1.0.95: nothing is revoked
 * on upgrade, and nothing is left behind on destroy.
 */
describe('project roles of an app', function() {
	useIsolatedHome();

	const migrationApp: Partial<ServiceArgs> = { database: {}, migration: { enabled: true }};
	const everything: Partial<ServiceArgs> = { ...migrationApp, worker: { kind: 'mig' }};

	/* [ description, arguments, the roles that are granted, one binding each ] */
	const rows: [ string, Partial<ServiceArgs>, string[] ][] = [
		[ 'a plain app', {}, [ LOG_WRITER ] ],
		[ 'an app with a database', { database: {}}, [ CLOUD_SQL_CLIENT, LOG_WRITER ] ],
		[ 'an app with a container VM worker', { worker: { kind: 'mig' }}, [ LOG_WRITER, METRIC_WRITER ] ],
		[ 'an app with a Cloud Run worker pool', { worker: { kind: 'crwp' }}, [ LOG_WRITER, METRIC_WRITER ] ],
		[ 'an app with a database, a migration and a worker', everything, [ CLOUD_SQL_CLIENT, LOG_WRITER, METRIC_WRITER ] ],
		[ 'an app with a worker pool, a database and a migration', { ...everything, worker: { kind: 'crwp' }}, [ CLOUD_SQL_CLIENT, LOG_WRITER, METRIC_WRITER ] ],
		/* The identity grants nothing for these: the worker and the migration job do, as in 1.0.95 */
		[ 'a plain app with a service account of the caller (C5)', { service: { serviceAccount: ACCOUNT }}, [] ],
		[ 'a service account of the caller, with a worker', { worker: { kind: 'mig' }, service: { serviceAccount: ACCOUNT }}, [ LOG_WRITER, METRIC_WRITER ] ],
		[ 'a service account of the caller, with a migration', { ...migrationApp, service: { serviceAccount: ACCOUNT }}, [ CLOUD_SQL_CLIENT ] ],
		[ 'a service account of the caller, with everything', { ...everything, service: { serviceAccount: ACCOUNT }}, [ CLOUD_SQL_CLIENT, LOG_WRITER, METRIC_WRITER ] ],
		[ 'a service account of the caller that also asks for the roles', { ...everything, service: { serviceAccount: ACCOUNT, grantIAMRoles: true }}, [ CLOUD_SQL_CLIENT, LOG_WRITER, METRIC_WRITER ] ],
		[ 'grantIAMRoles: false', { ...everything, service: { grantIAMRoles: false }}, [ CLOUD_SQL_CLIENT, LOG_WRITER, METRIC_WRITER ] ],
		[ 'grantIAMRoles: false with a worker pool', { ...everything, worker: { kind: 'crwp' }, service: { grantIAMRoles: false }}, [ CLOUD_SQL_CLIENT, LOG_WRITER, METRIC_WRITER ] ]
	];

	it.each(rows)('grants %s exactly once', async function(description, overrides, roles) {
		const tree = await captureService(`roles-${description.replace(/[^a-z]+/gi, '-').toLowerCase()}`, overrides);

		expect(liveRolesOf(tree.resources)).toEqual(roles);
	});

	/*
	 * A retained grant keeps a URN of 1.0.95 and nothing else: GCP holds one
	 * membership for a (project, role, member), so deleting either resource
	 * of a pair revokes it. Every retained grant therefore has a live twin
	 * that declares the same tuple, and the engine never sees the retained
	 * one change on its own.
	 */
	function tupleOf(grant: TreeResource) {
		const inputs = expectRecord(grant.inputs, `the inputs of ${grant.name}`);

		return(JSON.stringify([ inputs.project, inputs.role, inputs.member ]));
	}

	it.each(rows)('gives each retained grant of %s a live twin of the same project, role and member', async function(description, overrides) {
		const tree = await captureService(`twins-${description.replace(/[^a-z]+/gi, '-').toLowerCase()}`, overrides);
		const live = new Set(liveGrantsOf(tree.resources).map(tupleOf));
		const alone = retainedGrantsOf(tree.resources).filter(function(grant) {
			return(!live.has(tupleOf(grant)));
		});

		expect(alone.map(function(grant) {
			return(grant.name);
		})).toEqual([]);
	});

	it.each([ 'mig', 'crwp' ] as const)('keeps retained grants for a %s worker and a migration, so that the twin check above is not empty', async function(kind) {
		const tree = await captureService(`twins-present-${kind}`, { ...everything, worker: { kind }});

		expect(retainedGrantsOf(tree.resources).length).toBeGreaterThan(0);
	});

	/*
	 * The grants of the worker and of the migration job, when the identity
	 * grants nothing, are the ones of 1.0.95: live (never retained, so a
	 * destroy revokes the role) and at the URN they had.
	 */
	const accountOfCaller: Partial<ServiceArgs> = { service: { serviceAccount: ACCOUNT }};
	const grantsNothing: [ string, Partial<ServiceArgs> ][] = [
		[ 'a service account of the caller', accountOfCaller ],
		[ 'a service account of the caller that also asks for the roles', { service: { serviceAccount: ACCOUNT, grantIAMRoles: true }} ],
		[ 'grantIAMRoles: false', { service: { grantIAMRoles: false }} ]
	];
	const workers: [ 'mig' | 'crwp', string, string ][] = [
		[ 'mig', 'Keeta:GCP:ContainerMIG', 'mig' ],
		[ 'crwp', 'Keeta:GCP:ContainerCloudRun', 'crwp' ]
	];
	const liveChildren = grantsNothing.flatMap(function([ description, overrides ]) {
		return(workers.map(function([ kind, type, suffix ]): [ string, Partial<ServiceArgs>, 'mig' | 'crwp', string, string ] {
			return([ `${description}, with a ${kind} worker`, overrides, kind, type, suffix ]);
		}));
	});

	it.each(liveChildren)('keeps the live grants of the worker and the migration at their 1.0.95 URN with %s', async function(description, overrides, kind, type, suffix) {
		const name = `children-${description.replace(/[^a-z]+/gi, '-').toLowerCase()}`;
		const tree = await captureService(name, { ...migrationApp, ...overrides, worker: { kind }});
		const service = `Keeta:GCP:CloudRunService$${type}$${PROJECT_GRANT}`;
		const job = `Keeta:GCP:CloudRunService$Keeta:GCP:MigrationJob$${PROJECT_GRANT}`;

		expect(liveGrantsOf(tree.resources).map(function(grant) {
			return(grant.urn);
		}).sort()).toEqual([
			releasedUrn(tree, service, `${name}-${suffix}-iam-logging`),
			releasedUrn(tree, service, `${name}-${suffix}-iam-metric`),
			releasedUrn(tree, job, `${name}-migration-cloudsql-client`)
		].sort());
		expect(retainedGrantsOf(tree.resources)).toEqual([]);
	});

	/*
	 * `changeProjectIAMPolicy` replaces the IAMMember of the library, and it is
	 * called once for each role: a second call for the same role would be a
	 * second owner of it.
	 */
	const hookRows: [ string, Partial<ServiceArgs>, string[] ][] = [
		[ 'an account of the app', everything, [ CLOUD_SQL_CLIENT, LOG_WRITER, METRIC_WRITER ] ],
		[ 'an account of the app, with a worker pool', { ...everything, worker: { kind: 'crwp' }}, [ CLOUD_SQL_CLIENT, LOG_WRITER, METRIC_WRITER ] ],
		/* 1.0.95 asked for the roles of the worker and of the migration job here, and the app asked for none */
		[ 'an account of the caller, with everything', { ...everything, service: { serviceAccount: ACCOUNT }}, [ CLOUD_SQL_CLIENT, LOG_WRITER, METRIC_WRITER ] ],
		[ 'an account of the caller, with a worker', { worker: { kind: 'crwp' }, service: { serviceAccount: ACCOUNT }}, [ LOG_WRITER, METRIC_WRITER ] ],
		[ 'an account of the caller, with a migration', { ...migrationApp, service: { serviceAccount: ACCOUNT }}, [ CLOUD_SQL_CLIENT ] ],
		[ 'an account of the caller, plain', { service: { serviceAccount: ACCOUNT }}, [] ],
		[ 'grantIAMRoles: false, with everything', { ...everything, service: { grantIAMRoles: false }}, [ CLOUD_SQL_CLIENT, LOG_WRITER, METRIC_WRITER ] ],
		[ 'grantIAMRoles: false, plain', { service: { grantIAMRoles: false }}, [] ]
	];

	it.each(hookRows)('asks changeProjectIAMPolicy for each role once, with %s, and creates no grant of its own', async function(description, overrides, roles) {
		const asked: string[] = [];
		const tree = await captureService(`policy-${description.replace(/[^a-z]+/gi, '-').toLowerCase()}`, { ...overrides, gcp: { project: 'project-id', changeProjectIAMPolicy: recordingHook(asked) }});

		expect(asked.sort()).toEqual(roles);
		expect(liveRolesOf(tree.resources)).toEqual([]);
	});

	/*
	 * What the hook returns is what the service, the worker and the
	 * migration job wait for, whoever asked for the role. The resources of
	 * the hook are named after the role, so they are the same for any asker.
	 */
	function slug(role: string) {
		return(role.replace(/[^a-z]+/gi, '-'));
	}

	function resourceHook(): PolicyHook {
		return(function(role) {
			return(new gcp.projects.IAMMember(`hook-${slug(role)}`, { project: 'project-id', role, member: 'serviceAccount:other@project-id.iam.gserviceaccount.com' }));
		});
	}

	function waitsFor(tree: TreeSnapshot, target: TreeResource | undefined, roles: string[]) {
		const urns = roles.map(function(role) {
			return(tree.resources.filter(function(resource) {
				return(resource.name === `hook-${slug(role)}`);
			}).map(function(resource) {
				return(resource.urn);
			}));
		}).flat();

		expect(urns).toHaveLength(roles.length);
		expect(target?.dependsOn ?? []).toEqual(expect.arrayContaining(urns));
	}

	function targetsOf(tree: TreeSnapshot, app: string, workerType: string) {
		const named = function(type: string, name: string) {
			return(tree.resources.find(function(resource) {
				return(resource.type === type && resource.name === name);
			}));
		};
		const services = tree.resources.filter(function(resource) {
			return(resource.type === 'gcp:cloudrun/service:Service');
		});

		return({
			service: services[0],
			services: services.length,
			worker: tree.resources.find(function(resource) {
				return(resource.type === workerType && resource.name.startsWith(app));
			}),
			migration: named('pulumi-nodejs:dynamic:Resource', `${app}-migration-exec`)
		});
	}

	/* [ worker kind, the type of the resource that runs the worker ] */
	const workerTypes: [ 'mig' | 'crwp', string ][] = [
		[ 'mig', 'gcp:compute/regionInstanceGroupManager:RegionInstanceGroupManager' ],
		[ 'crwp', 'gcp:cloudrunv2/workerPool:WorkerPool' ]
	];

	it.each(workerTypes)('makes the service, the %s worker and the migration job wait for what the hook returns', async function(kind, workerType) {
		const name = `waits-${kind}`;
		const tree = await captureService(name, { ...everything, worker: { kind }, gcp: { project: 'project-id', changeProjectIAMPolicy: resourceHook() }});
		const { service, services, worker, migration } = targetsOf(tree, name, workerType);
		const roles = [ CLOUD_SQL_CLIENT, LOG_WRITER, METRIC_WRITER ];

		expect(services).toBe(1);
		waitsFor(tree, service, roles);
		waitsFor(tree, worker, roles);
		waitsFor(tree, migration, [ CLOUD_SQL_CLIENT ]);
	});

	it.each(workerTypes)('makes the %s worker and the migration job wait for what the hook returns when the account is the caller\'s', async function(kind, workerType) {
		const name = `waits-caller-${kind}`;
		const tree = await captureService(name, { ...everything, worker: { kind }, service: { serviceAccount: ACCOUNT }, gcp: { project: 'project-id', changeProjectIAMPolicy: resourceHook() }});
		const { worker, migration } = targetsOf(tree, name, workerType);

		waitsFor(tree, worker, [ LOG_WRITER, METRIC_WRITER ]);
		waitsFor(tree, migration, [ CLOUD_SQL_CLIENT ]);
	});
});

/*
 * With an `identity`, a component does not grant the roles that the identity
 * grants. Its old grants of those roles are still in the program, retained,
 * so the bindings in GCP stay and the resources keep their state. For any
 * other role, and without an identity, it grants as in 1.0.95.
 */
describe('components that receive an identity', function() {
	useIsolatedHome();

	function identityOf(grantedRoles: string[]): IdentityRef {
		return({ email: ACCOUNT, grants: [], grantedRoles });
	}

	function identityOption(identity: IdentityRef | undefined) {
		if (identity === undefined) {
			return({});
		}

		return({ identity });
	}

	function mig(name: string, identity: IdentityRef | undefined, hook: PolicyHook) {
		return(new ContainerMIG(name, {
			serviceAccount: ACCOUNT,
			subnetwork: workerSubnetwork(name),
			common: { gcp: gcpOptions(hook) },
			containerSpec: workerSpec,
			...identityOption(identity)
		}));
	}

	function crwp(name: string, identity: IdentityRef | undefined, hook: PolicyHook) {
		return(new ContainerCloudRun(name, {
			serviceAccount: ACCOUNT,
			subnetwork: workerSubnetwork(name),
			common: { gcp: gcpOptions(hook) },
			containerSpec: workerSpec,
			...identityOption(identity)
		}));
	}

	function migrationJob(name: string, identity: IdentityRef | undefined, hook: PolicyHook) {
		return(new MigrationJob(name, {
			gcp: gcpOptions(hook),
			region: 'us-central1',
			database: { host: '10.0.0.5', caCertificate: 'certificate', username: 'user', password: 'password', databaseName: 'database' },
			image: IMAGE,
			serviceAccount: { email: pulumi.output(ACCOUNT) },
			...identityOption(identity)
		}));
	}

	type Build = (name: string, identity: IdentityRef | undefined, hook: PolicyHook) => unknown;

	/* [ component, how to build it, the roles it grants for itself ] */
	const rows: [ string, Build, string[] ][] = [
		[ 'ContainerMIG', mig, [ LOG_WRITER, METRIC_WRITER ] ],
		[ 'ContainerCloudRun', crwp, [ LOG_WRITER, METRIC_WRITER ] ],
		[ 'MigrationJob', migrationJob, [ CLOUD_SQL_CLIENT ] ]
	];

	function capture(component: string, build: Build, identity: IdentityRef | undefined, hook: PolicyHook) {
		return(captureTree(function() {
			return(build(`own-${component}`, identity, hook));
		}));
	}

	it.each(rows)('%s grants for itself when it has no identity', async function(component, build, roles) {
		const tree = await capture(component, build, undefined, undefined);

		expect(liveRolesOf(tree.resources)).toEqual(roles);
		expect(retainedGrantsOf(tree.resources)).toEqual([]);
	});

	it.each(rows)('%s keeps its grants as retained tombstones when the identity grants the same roles', async function(component, build, roles) {
		const tree = await capture(component, build, identityOf(roles), undefined);

		expect(liveRolesOf(tree.resources)).toEqual([]);
		expect(retainedGrantsOf(tree.resources).map(roleOf).sort()).toEqual(roles);
	});

	/* A role that the identity does not grant stays what it was in 1.0.95: a grant of the component, revoked with it */
	it.each(rows)('%s keeps live grants when the identity grants nothing', async function(component, build, roles) {
		const tree = await capture(component, build, identityOf([]), undefined);

		expect(liveRolesOf(tree.resources)).toEqual(roles);
		expect(retainedGrantsOf(tree.resources)).toEqual([]);
	});

	it.each(rows)('%s keeps live grants when the identity grants other roles only', async function(component, build, roles) {
		const tree = await capture(component, build, identityOf([ 'roles/viewer' ]), undefined);

		expect(liveRolesOf(tree.resources)).toEqual(roles);
		expect(retainedGrantsOf(tree.resources)).toEqual([]);
	});

	/* [ component, the role the identity grants, the role left to the component, how to build it ] */
	const partialRows: [ string, string, string, Build ][] = [
		[ 'ContainerMIG', LOG_WRITER, METRIC_WRITER, mig ],
		[ 'ContainerMIG', METRIC_WRITER, LOG_WRITER, mig ],
		[ 'ContainerCloudRun', LOG_WRITER, METRIC_WRITER, crwp ],
		[ 'ContainerCloudRun', METRIC_WRITER, LOG_WRITER, crwp ]
	];

	it.each(partialRows)('%s retains only the grant of the role that the identity grants (%s)', async function(component, granted, left, build) {
		const tree = await capture(component, build, identityOf([ granted ]), undefined);

		expect(retainedGrantsOf(tree.resources).map(roleOf)).toEqual([ granted ]);
		expect(liveRolesOf(tree.resources)).toEqual([ left ]);
	});

	/*
	 * With a hook the component asks for the roles that the identity does not
	 * grant, as it did in 1.0.95, and for none that it does grant (the
	 * identity asks for those once).
	 */
	it.each(rows)('%s asks the hook for its roles when it has no identity', async function(component, build, roles) {
		const asked: string[] = [];
		const tree = await capture(component, build, undefined, recordingHook(asked));

		expect(asked.sort()).toEqual(roles);
		expect(grantsOf(tree.resources)).toEqual([]);
	});

	it.each(rows)('%s asks the hook for its roles when the identity grants nothing', async function(component, build, roles) {
		const asked: string[] = [];
		const tree = await capture(component, build, identityOf([]), recordingHook(asked));

		expect(asked.sort()).toEqual(roles);
		expect(grantsOf(tree.resources)).toEqual([]);
	});

	it.each(rows)('%s does not ask the hook for the roles that the identity grants', async function(component, build, roles) {
		const asked: string[] = [];
		const tree = await capture(component, build, identityOf(roles), recordingHook(asked));

		expect(asked).toEqual([]);
		expect(grantsOf(tree.resources)).toEqual([]);
	});

	it.each(partialRows)('%s asks the hook only for the role that the identity does not grant (%s granted)', async function(component, granted, left, build) {
		const asked: string[] = [];

		await capture(component, build, identityOf([ granted ]), recordingHook(asked));

		expect(asked).toEqual([ left ]);
	});
});

