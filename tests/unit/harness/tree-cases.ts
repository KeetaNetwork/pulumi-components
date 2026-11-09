import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gcp from '@pulumi/gcp';

import type * as apps from '../../../src/packages/gcp/apps';
import type * as container from '../../../src/packages/gcp/container';
import type * as lb from '../../../src/packages/gcp/lb';
import type * as migration from '../../../src/packages/gcp/migration';
import type * as sql from '../../../src/packages/gcp/sql';
import { requireSource } from './load-sources';

const { CloudRunService, FullStackApp, StaticWebApp } = requireSource<typeof apps>('src/packages/gcp/apps.ts');
const { ContainerCloudRun, ContainerMIG } = requireSource<typeof container>('src/packages/gcp/container.ts');
const { MigrationJob } = requireSource<typeof migration>('src/packages/gcp/migration.ts');
const { ExternalLoadBalancer, InternalLoadBalancer } = requireSource<typeof lb>('src/packages/gcp/lb.ts');
const { PostgresCloudSQL } = requireSource<typeof sql>('src/packages/gcp/sql.ts');

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures');
const APP_DIRECTORY = path.join(fixtures, 'app');
const STATIC_DIRECTORY = path.join(fixtures, 'static');

const PROJECT = 'project-id';
const REGION = 'us-central1';
const IMAGE = `${REGION}-docker.pkg.dev/${PROJECT}/keeta/app:1`;
const DOMAIN_CONFIG = { domain: 'app.example.com', ssl: { domains: [ 'app.example.com' ] }};

/**
 * One program whose resource tree is pinned. `build` creates the components
 * (and anything the caller of a component would create itself).
 */
export interface TreeCase {
	name: string;
	build: () => unknown;
}

type ServiceArgs = ConstructorParameters<typeof CloudRunService>[1];
type ServiceOptions = ConstructorParameters<typeof CloudRunService>[2];

/** A `CloudRunService` named after its case; `image` is replaced by the overrides when they bring their own */
function serviceCase(name: string, overrides: Partial<ServiceArgs>, options?: ServiceOptions): TreeCase {
	return({
		name,
		build: function() {
			return(new CloudRunService(name, { gcp: { project: PROJECT }, region: REGION, image: { uri: IMAGE }, ...overrides }, options));
		}
	});
}

/** A container worker needs a subnetwork, which its caller creates */
export function workerSubnetwork(name: string) {
	const network = new gcp.compute.Network(`${name}-network`, { autoCreateSubnetworks: false });

	return(new gcp.compute.Subnetwork(`${name}-subnet`, { network: network.selfLink, region: REGION, ipCidrRange: '10.0.0.0/24' }));
}

export const workerSpec: ConstructorParameters<typeof ContainerMIG>[1]['containerSpec'] = {
	containers: [ { image: IMAGE, name: 'worker', restartPolicy: 'Always' } ]
};

/** What the standalone load balancers need besides their own arguments: a worker group to balance, and a health check for it */
function balancedWorker(name: string) {
	const subnetwork = workerSubnetwork(`${name}-worker`);
	const worker = new ContainerMIG(`${name}-worker`, {
		serviceAccount: 'worker@project-id.iam.gserviceaccount.com',
		subnetwork,
		common: { gcp: { project: PROJECT }},
		containerSpec: workerSpec
	});
	const healthCheck = new gcp.compute.HealthCheck(`${name}-health`, { httpHealthCheck: { port: 8080 }});

	return({ subnetwork, worker, healthCheck });
}

export const TREE_CASES: TreeCase[] = [
	{
		name: 'static-web-app',
		build: function() {
			return(new StaticWebApp('static-web-app', { staticFilesPath: STATIC_DIRECTORY }));
		}
	},
	{
		name: 'static-web-app-load-balancer',
		build: function() {
			return(new StaticWebApp('static-web-app-lb', {
				staticFilesPath: STATIC_DIRECTORY,
				loadBalancer: { ...DOMAIN_CONFIG, dnsZoneId: 'zone-id' }
			}));
		}
	},
	serviceCase('service-plain', {}),
	serviceCase('service-database', {
		database: {},
		migration: { enabled: true },
		environment: { LOG_LEVEL: 'info' }
	}),
	serviceCase('service-kv', { kv: { type: 'redis', memorySizeGb: 1 }}),
	serviceCase('service-environment', {
		environment: {
			PLAIN: 'value',
			SECRET: { value: 'hidden', secret: true },
			EXISTING: { name: 'existing-secret', version: '3' }
		}
	}),
	serviceCase('service-mig', {
		mig: { enabled: true, egress: 'vpc+nat', enableSSH: true },
		environment: { MODE: 'worker' }
	}),
	serviceCase('service-crwp', { mig: { enabled: true, workerKind: 'crwp', egress: 'vpc+nat' }}),
	serviceCase('service-build-local', {
		image: { build: { directory: APP_DIRECTORY, imageName: 'service-build-local' }}
	}),
	serviceCase('service-build-remote', {
		image: { build: { directory: APP_DIRECTORY, imageName: 'service-build-remote', githubSha: 'sha-1', remote: {}}}
	}),
	{
		name: 'service-caller-resources',
		build: function() {
			const network = new gcp.compute.Network('caller-network', { autoCreateSubnetworks: false });
			const account = new gcp.serviceaccount.Account('caller-account', { accountId: 'caller-account' });

			return(new CloudRunService('service-caller-resources', {
				gcp: { project: PROJECT },
				region: REGION,
				image: { uri: IMAGE },
				database: {},
				vpc: { network },
				service: { serviceAccount: account }
			}));
		}
	},
	{
		name: 'service-providers',
		build: function() {
			const provider = new gcp.Provider('caller-provider', { project: PROJECT });

			return(new CloudRunService('service-providers', {
				gcp: { project: PROJECT },
				region: REGION,
				image: { build: { directory: APP_DIRECTORY, imageName: 'service-providers', githubSha: 'sha-2', remote: {}}},
				database: {},
				migration: { enabled: true },
				environment: { SECRET: { value: 'hidden', secret: true }},
				mig: { enabled: true }
			}, { providers: [ provider ] }));
		}
	},
	serviceCase('service-replicas', {
		database: {
			replication: { multiZone: true, replicaRegions: [ 'us-east1' ] },
			backups: { pointInTimeRecovery: true }
		}
	}),
	{
		name: 'postgres-peering',
		build: function() {
			const network = new gcp.compute.Network('postgres-network', { autoCreateSubnetworks: false });

			return(new PostgresCloudSQL('postgres-peering', {
				region: REGION,
				tier: 'db-f1-micro',
				vpcNetwork: network,
				createPeering: true
			}));
		}
	},
	{
		name: 'standalone-mig',
		build: function() {
			return(new ContainerMIG('standalone-mig', {
				serviceAccount: 'worker@project-id.iam.gserviceaccount.com',
				subnetwork: workerSubnetwork('standalone-mig'),
				common: { gcp: { project: PROJECT }},
				containerSpec: workerSpec
			}));
		}
	},
	{
		name: 'standalone-container-cloud-run',
		build: function() {
			return(new ContainerCloudRun('standalone-crwp', {
				serviceAccount: 'worker@project-id.iam.gserviceaccount.com',
				subnetwork: workerSubnetwork('standalone-crwp'),
				common: { gcp: { project: PROJECT }},
				containerSpec: workerSpec
			}));
		}
	},
	{
		name: 'standalone-migration-job',
		build: function() {
			return(new MigrationJob('standalone-migration', {
				gcp: { project: PROJECT },
				region: REGION,
				database: {
					host: '10.0.0.5',
					caCertificate: 'certificate',
					username: 'user',
					password: 'password',
					databaseName: 'database'
				},
				image: IMAGE
			}));
		}
	},
	{
		name: 'full-stack-app',
		build: function() {
			return(new FullStackApp('full-stack', {
				loadBalancer: DOMAIN_CONFIG,
				frontend: { staticFilesPath: STATIC_DIRECTORY },
				backend: { gcp: { project: PROJECT }, region: REGION, image: { uri: IMAGE }}
			}));
		}
	},
	{
		name: 'full-stack-app-without-frontend',
		build: function() {
			return(new FullStackApp('full-stack-api', {
				loadBalancer: DOMAIN_CONFIG,
				frontend: null,
				backend: { gcp: { project: PROJECT }, region: REGION, image: { uri: IMAGE }}
			}));
		}
	},
	{
		name: 'external-load-balancer',
		build: function() {
			return(new ExternalLoadBalancer('external-load-balancer', {
				common: { gcp: { project: PROJECT }},
				baseDescription: 'test app',
				healthCheck: new gcp.compute.HealthCheck('external-load-balancer-health', { httpHealthCheck: { port: 8080 }}),
				target: { type: 'NEG', host: 'backend.example.com' },
				domainName: 'app.example.com'
			}));
		}
	},
	{
		name: 'external-load-balancer-mig',
		build: function() {
			const { worker, healthCheck } = balancedWorker('external-load-balancer-mig');
			const certificate = new gcp.certificatemanager.Certificate('external-load-balancer-mig-cert', { managed: { domains: [ 'app.example.com' ] }});

			return(new ExternalLoadBalancer('external-load-balancer-mig', {
				common: { gcp: { project: PROJECT }},
				baseDescription: 'test app',
				healthCheck,
				target: worker,
				sslCertificate: certificate,
				allowedSources: [ '10.0.0.0/8' ]
			}));
		}
	},
	{
		name: 'internal-load-balancer',
		build: function() {
			const { subnetwork, worker, healthCheck } = balancedWorker('internal-load-balancer');

			return(new InternalLoadBalancer('internal-load-balancer', {
				common: { gcp: { project: PROJECT }},
				baseDescription: 'test app',
				healthCheck,
				target: worker,
				subnetwork,
				proxySubnetworkCIDR: '10.1.0.0/24',
				domainName: 'app.example.com',
				allowedSources: [ '10.0.0.0/8' ]
			}));
		}
	}
];
