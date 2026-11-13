import type * as apps from '../../../src/packages/gcp/apps';
import type * as defaults from '../../../src/packages/gcp/defaults';
import { requireSource } from './load-sources';
import { captureTree } from './pulumi-tree';

const { CloudRunService } = requireSource<typeof apps>('src/packages/gcp/apps.ts');
const { CLOUD_RUN_SERVICE_DEFAULTS } = requireSource<typeof defaults>('src/packages/gcp/defaults.ts');

type ServiceArgs = ConstructorParameters<typeof CloudRunService>[1];

export const IMAGE = 'us-central1-docker.pkg.dev/project-id/keeta/app:1';

/** A CloudRunService of the test project with a ready image, and the arguments that a test changes */
export function buildService(name: string, overrides: Partial<ServiceArgs>) {
	return(new CloudRunService(name, { gcp: { project: 'project-id' }, region: 'us-central1', image: { uri: IMAGE }, ...overrides }));
}

/** The arguments of an AppNetwork in the test region, with the defaults of the library */
export function appNetworkArgs() {
	return({ region: 'us-central1' as const, ...CLOUD_RUN_SERVICE_DEFAULTS.network });
}

/** The resource tree of a program that builds one CloudRunService (see `buildService`) */
export function captureService(name: string, overrides: Partial<ServiceArgs>) {
	return(captureTree(function() {
		return(buildService(name, overrides));
	}));
}
