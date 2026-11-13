import type * as apps from '../../src/packages/gcp/apps';

type ServiceArgs = ConstructorParameters<typeof apps.CloudRunService>[1];

/** One worker written the legacy way (`mig`) and the typed way (`worker`) */
export interface WorkerForm {
	description: string;
	legacy: NonNullable<ServiceArgs['mig']>;
	worker: NonNullable<ServiceArgs['worker']>;
	kind: 'mig' | 'crwp';
	/** The component that the worker becomes */
	componentType: string;
}

export const WORKER_FORMS: WorkerForm[] = [
	{ description: 'a container VM worker with every default', legacy: { enabled: true }, worker: { kind: 'mig' }, kind: 'mig', componentType: 'Keeta:GCP:ContainerMIG' },
	{ description: 'a container VM worker named by workerKind', legacy: { enabled: true, workerKind: 'mig' }, worker: { kind: 'mig' }, kind: 'mig', componentType: 'Keeta:GCP:ContainerMIG' },
	{
		description: 'a container VM worker with every option',
		legacy: { enabled: true, instanceCount: 2, machineType: 'e2-small', cosImage: 'cos-stable', enableSSH: true, tags: [ 'a', 'b' ], egress: 'vpc+direct', environmentOverrides: { A: '1' }},
		worker: { kind: 'mig', instanceCount: 2, machineType: 'e2-small', cosImage: 'cos-stable', enableSSH: true, tags: [ 'a', 'b' ], egress: 'vpc+direct', environmentOverrides: { A: '1' }},
		kind: 'mig',
		componentType: 'Keeta:GCP:ContainerMIG'
	},
	{ description: 'a Cloud Run worker pool with every default', legacy: { enabled: true, workerKind: 'crwp' }, worker: { kind: 'crwp' }, kind: 'crwp', componentType: 'Keeta:GCP:ContainerCloudRun' },
	{
		description: 'a Cloud Run worker pool with every option',
		legacy: { enabled: true, workerKind: 'crwp', instanceCount: 3, machineType: 'e2-medium', tags: [ 't' ], egress: 'vpc+nat', environmentOverrides: { B: '2' }},
		worker: { kind: 'crwp', instanceCount: 3, machineType: 'e2-medium', tags: [ 't' ], egress: 'vpc+nat', environmentOverrides: { B: '2' }},
		kind: 'crwp',
		componentType: 'Keeta:GCP:ContainerCloudRun'
	}
];
