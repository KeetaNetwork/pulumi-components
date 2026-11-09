/**
 * Default values of the GCP components.
 *
 * This module is the one home of every value that a component falls back to
 * when its caller says nothing. The objects are frozen when the module loads,
 * so no component can change what another one reads. Each object belongs to
 * one entry point: the same setting may have a different default in another
 * one (a worker VM from `CloudRunService` is an `e2-micro`, while a
 * `ContainerMIG` that nobody sized is an `e2-medium`), and the objects are
 * never merged.
 *
 * The values are those of 1.0.95.
 */

/** Freezes the object and everything inside it */
function deepFreeze<const T extends object>(value: T): Readonly<T> {
	const children: unknown[] = Object.values(value);
	for (const child of children) {
		if (typeof child === 'object' && child !== null) {
			deepFreeze(child);
		}
	}

	return(Object.freeze(value));
}

/** Defaults of the Cloud SQL instance (sql.ts) and of `CloudRunService.database` */
export const POSTGRES_DEFAULTS = deepFreeze({
	tier: 'db-f1-micro',
	version: 'POSTGRES_14',
	queryStringLength: 4500,
	maxConnections: 25000,
	deletionProtection: false,
	queryInsights: false,

	/** Prefix length of the private service access range that the instance is reached through */
	psaPrefixLength: 16
});

/** Defaults of `CloudRunService` (apps.ts) */
export const CLOUD_RUN_SERVICE_DEFAULTS = deepFreeze({
	service: {
		/** CPU limit, in cores */
		cpuLimit: 1,

		/** Memory limit, in MB */
		memoryLimit: 512
	},

	/** Defaults of the VPC that the service creates when it needs one */
	network: {
		subnetCIDR: '10.97.35.0/24',
		connectorCIDR: '10.97.36.0/28',
		connector: {
			minInstances: 2,
			maxInstances: 3
		},

		/** Prefix length of the private service access range (the Cloud SQL peering) */
		psaPrefixLength: POSTGRES_DEFAULTS.psaPrefixLength
	},

	kv: {
		/** Priority of the firewall that lets the VPC connector reach the key-value store */
		firewallPriority: 850
	},

	/** Defaults of the worker of `CloudRunService`, for both kinds */
	worker: {
		machineType: 'e2-micro',
		egress: 'vpc',
		instanceCount: 1,
		enableSSH: false,

		/** The range that GCP uses for IAP and the priority of the firewall that lets it reach SSH */
		sshIAPRange: '35.235.240.0/20',
		sshIAPPriority: 900
	}
});

/** Defaults of the image build (docker.ts) and of `CloudRunService.image.build` */
export const BUILD_DEFAULTS = deepFreeze({
	platform: 'linux/amd64',

	/** Time that Cloud Build gives a remote build, in seconds (8 hours) */
	timeoutSeconds: 28800,
	machineType: 'E2_HIGHCPU_8',

	/** The pieces of the registry that the image goes to: `<region>-<domain>/<project>/<repository>` */
	registry: {
		domain: 'docker.pkg.dev',
		repository: 'keeta'
	}
});

/** Defaults of the container workers (container.ts) */
export const CONTAINER_DEFAULTS = deepFreeze({
	/** Managed instance group of VMs */
	mig: {
		machineType: 'e2-medium',
		diskSizeGb: 50,
		scopes: [
			'https://www.googleapis.com/auth/cloud-platform',
			'https://www.googleapis.com/auth/compute',
			'https://www.googleapis.com/auth/devstorage.read_only',
			'https://www.googleapis.com/auth/logging.write',
			'https://www.googleapis.com/auth/monitoring.write',
			'https://www.googleapis.com/auth/servicecontrol',
			'https://www.googleapis.com/auth/service.management.readonly'
		]
	},

	/** Cloud Run worker pool */
	crwp: {
		size: {
			/** Cores */
			cpu: '2',

			/** MiB */
			ram: '4096'
		}
	}
});

/** Defaults of the migration job (migration.ts) */
export const MIGRATION_DEFAULTS = deepFreeze({
	/** CPU limit, in cores */
	cpuLimit: 1,

	/** Memory limit, in MB */
	memoryLimit: 512,

	/** Task timeout, in seconds */
	taskTimeout: 600,
	maxRetries: 1
});

/**
 * Which paths the URL map of a front end sends to the static bucket. The two
 * front ends differ on purpose: `FullStackApp` also serves the favicon from
 * the bucket, and `StaticWebApp` serves no exact file. Unifying the lists
 * would update the URL map of every deployed app.
 */
export const ROUTING_DEFAULTS = deepFreeze({
	staticWebApp: {
		staticPaths: [ '/assets/', '/icons/', '/fonts/', '/images/' ],
		staticFiles: []
	},
	fullStack: {
		staticPaths: [ '/assets/', '/icons/', '/fonts/', '/images/' ],
		staticFiles: [ '/favicon.svg' ]
	}
});

/** Defaults of the HTTPS front end (`https-frontend.ts`) */
export const FRONT_END_DEFAULTS = deepFreeze({
	/** The SSL policy that a front end creates for its proxy when the caller gives none */
	sslPolicy: {
		profile: 'MODERN',
		minTlsVersion: 'TLS_1_2'
	}
});
