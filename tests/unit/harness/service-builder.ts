import * as gcp from '@pulumi/gcp';

import type * as apps from '../../../src/packages/gcp/apps';
import type * as defaults from '../../../src/packages/gcp/defaults';
import type * as sql from '../../../src/packages/gcp/sql';
import { expectArray, expectDefined, expectRecord, expectString, optionalRecord, valueAt } from '../../helpers/narrow';
import { requireSource } from './load-sources';
import { captureTree, ofType } from './pulumi-tree';
import type { TreeSnapshot } from './pulumi-tree';

const { CloudRunService } = requireSource<typeof apps>('src/packages/gcp/apps.ts');
const { PostgresCloudSQL } = requireSource<typeof sql>('src/packages/gcp/sql.ts');
const { CLOUD_RUN_SERVICE_DEFAULTS } = requireSource<typeof defaults>('src/packages/gcp/defaults.ts');

type ServiceArgs = ConstructorParameters<typeof CloudRunService>[1];

const IMAGE = 'us-central1-docker.pkg.dev/project-id/keeta/app:1';

/** A CloudRunService of the test project with a ready image, and the arguments that a test changes */
export function buildService(name: string, overrides: Partial<ServiceArgs>) {
	return(new CloudRunService(name, { gcp: { project: 'project-id' }, region: 'us-central1', image: { uri: IMAGE }, ...overrides }));
}

/** The resource tree of a program that builds one CloudRunService (see `buildService`) */
export function captureService(name: string, overrides: Partial<ServiceArgs>) {
	return(captureTree(function() {
		return(buildService(name, overrides));
	}));
}

/** The `envs` of the first container found in the inputs of a resource */
function findEnvs(value: unknown): unknown[] {
	if (Array.isArray(value)) {
		const items: unknown[] = value;
		for (const item of items) {
			const found = findEnvs(item);
			if (found.length > 0) {
				return(found);
			}
		}

		return([]);
	}

	const record = optionalRecord(value);
	if (record === undefined) {
		return([]);
	}

	if (Array.isArray(record.envs)) {
		const envs: unknown[] = record.envs;

		return(envs);
	}

	for (const nested of Object.values(record)) {
		const found = findEnvs(nested);
		if (found.length > 0) {
			return(found);
		}
	}

	return([]);
}

/** What a runtime is given for each variable: `value:<plain>`, or `secret:<name of the secret>` */
export function environmentOf(tree: TreeSnapshot, type: string) {
	const resource = tree.resources.find(function(candidate) {
		return(candidate.type === type);
	});
	const described: { [name: string]: string } = {};
	for (const entry of findEnvs(resource?.inputs)) {
		const record = optionalRecord(entry);
		const reference = optionalRecord(optionalRecord(record?.valueFrom ?? record?.valueSource)?.secretKeyRef);
		const secretName = reference?.name ?? reference?.secret;
		const name = expectString(record?.name, 'the name of a variable');
		if (typeof secretName === 'string') {
			described[name] = `secret:${secretName}`;
		} else if (typeof record?.value === 'string') {
			described[name] = `value:${record.value}`;
		}
	}

	return(described);
}

/** The arguments of an AppNetwork in the test region, with the defaults of the library */
export function appNetworkArgs() {
	return({ region: 'us-central1' as const, ...CLOUD_RUN_SERVICE_DEFAULTS.network });
}

/** The annotations of the template of the one Cloud Run service in a tree */
export function annotationsOf(tree: TreeSnapshot) {
	const [ service ] = ofType(tree, 'gcp:cloudrun/service:Service');

	return(expectRecord(valueAt(service?.inputs, [ 'template', 'metadata', 'annotations' ]) ?? {}, 'the annotations of the service'));
}

/** The settings of the first database instance in a tree: `path` is read from its inputs */
export function databaseInput(tree: TreeSnapshot, path: (string | number)[]) {
	const [ instance ] = ofType(tree, 'gcp:sql/databaseInstance:DatabaseInstance');

	return(valueAt(instance?.inputs, path));
}

/** The database flags of the first database instance in a tree, by name, as text */
export function flagsOf(tree: TreeSnapshot) {
	const flags = expectArray(databaseInput(tree, [ 'settings', 'databaseFlags' ]) ?? [], 'the database flags');

	return(Object.fromEntries(flags.map(function(flag) {
		const record = expectRecord(flag, 'a database flag');

		return([ String(record.name), String(record.value) ]);
	})));
}

/** Builds a component in a program and returns it with the tree it made */
export async function captureComponent<Value>(build: () => Value) {
	const built: Value[] = [];
	const tree = await captureTree(function() {
		built.push(build());
	});

	return({ tree, value: expectDefined(built[0], 'the component') });
}

export type DatabaseArgs = Partial<ConstructorParameters<typeof PostgresCloudSQL>[1]>;

export function buildDatabase(name: string, args: DatabaseArgs) {
	return(captureComponent(function() {
		const network = new gcp.compute.Network(`${name}-network`, { autoCreateSubnetworks: false });

		return(new PostgresCloudSQL(name, { region: 'us-central1', tier: 'db-f1-micro', vpcNetwork: network, createPeering: true, ...args }));
	}));
}

