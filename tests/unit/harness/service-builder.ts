import type * as apps from '../../../src/packages/gcp/apps';
import type * as defaults from '../../../src/packages/gcp/defaults';
import { expectString, optionalRecord } from '../../helpers/narrow';
import { requireSource } from './load-sources';
import { captureTree } from './pulumi-tree';
import type { TreeSnapshot } from './pulumi-tree';

const { CloudRunService } = requireSource<typeof apps>('src/packages/gcp/apps.ts');
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
