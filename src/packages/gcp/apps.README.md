# GCP Application Components

Composable Pulumi components for deploying applications to Google Cloud Platform. Each component can be used independently or composed together.

## StaticWebApp

Deploys static files to a GCS bucket with a backend bucket for load balancer integration. Optionally creates a standalone HTTPS load balancer.

- Uploads files to GCS with per-file cache control (index, hashed assets, other)
- Creates a `BackendBucket` for use in URL maps
- Optional standalone HTTPS load balancer with SSL and DNS
- SPA routing (all unmatched paths rewrite to `/`)

```typescript
const app = new components.gcp.apps.StaticWebApp('my-app', {
	staticFilesPath: './dist',
	fileFilter: (file) => file !== '.done',
	cacheControl: {
		indexTTL: 10,
		assetsTTL: 86400,
		defaultTTL: 300
	},
	loadBalancer: {
		domain: 'app.example.com',
		dnsZoneId: 'my-dns-zone',
		ssl: {
			domains: ['app.example.com']
		}
	}
});
```

When used inside `FullStackApp`, omit `loadBalancer` -- the parent component manages routing.

## CloudRunService

Deploys a containerized backend to Cloud Run with optional PostgreSQL database, migration jobs, and MIG workers.

- Docker image building or pre-built URI
- Optional Cloud SQL PostgreSQL with VPC peering (VPC and connector created automatically)
- Environment variable and secret management via `EnvManager`
- Service account creation and IAM grants
- Optional database migration via Cloud Run Job (runs automatically during deployment)
- Optional MIG worker for background tasks (shares the same image and database credentials)
- Exposes a `BackendService` for load balancer integration

```typescript
const service = new components.gcp.apps.CloudRunService('my-service', {
	gcp: {
		project: 'my-project',
		changeProjectIAMPolicy: myIAMPolicyFunction
	},
	region: 'us-central1',
	image: {
		build: {
			directory: './src',
			imageName: 'my-service',
			target: 'runner'
		}
	},
	environment: {
		APP_SEED: { value: seed, secret: true },
		APP_PUBLIC_URL: 'https://api.example.com'
	},
	database: {
		tier: 'db-f1-micro',
		queryInsights: false
	},
	migration: {
		enabled: true,
		container: {
			entrypoint: ['node', 'dist/migrate.js']
		},
		cpuLimit: 1,
		memoryLimit: 512,
		taskTimeout: 600
	}
});

// Exposed resources:
// service.service        - Cloud Run Service
// service.database       - PostgresCloudSQL instance
// service.migration      - MigrationJob (status, logUri)
// service.backendService - BackendService for LB integration
// service.mig            - ContainerMIG worker (if enabled)
```

## FullStackApp

Composes `StaticWebApp` and `CloudRunService` behind a shared HTTPS load balancer with configurable route rules.

```typescript
const app = new components.gcp.apps.FullStackApp('my-app', {
	loadBalancer: {
		domain: 'app.example.com',
		dnsZoneId: 'my-dns-zone',
		ssl: {
			domains: ['app.example.com']
		}
	},
	frontend: {
		staticFilesPath: './client/dist',
		cacheControl: {
			indexTTL: 10,
			assetsTTL: 86400
		}
	},
	backend: {
		gcp: { project: 'my-project' },
		region: 'us-central1',
		image: {
			build: {
				directory: './api',
				imageName: 'my-app-api'
			}
		},
		environment: {
			APP_SEED: { value: seed, secret: true }
		},
		database: { tier: 'db-f1-micro' },
		migration: {
			enabled: true,
			container: {
				entrypoint: ['node', 'dist/migrate.js']
			}
		}
	},
	routing: {
		apiPrefix: '/api',
		staticPaths: ['/assets/', '/icons/'],
		staticFiles: ['/favicon.svg']
	}
});

// app.frontend - StaticWebApp instance
// app.backend  - CloudRunService instance
// app.ips      - Load balancer IPs
```

### Routing

`FullStackApp` builds a URL map with the following priority order:

1. `staticPaths` -- prefix-matched to the frontend bucket (default: `/assets/`, `/icons/`, `/fonts/`, `/images/`)
2. `staticFiles` -- exact-matched to the frontend bucket (default: `/favicon.svg`)
3. `apiPrefix` -- path-template-matched to the backend service (default: `/api/**`)
4. Catch-all -- rewrites to `/` on the frontend bucket (SPA fallback)

```
┌────────────────────────────────────────────────┐
│ FullStackApp                                   │
│                                                │
│  ┌────────────────┐      ┌──────────────────┐  │
│  │ StaticWebApp   │      │ CloudRunService  │  │
│  │                │      │                  │  │
│  │ - GCS Bucket   │      │ - Cloud Run      │  │
│  │ - Backend      │      │ - Database       │  │
│  │   Bucket       │      │ - VPC            │  │
│  └────────────────┘      │ - Migration      │  │
│           │              │ - MIG Worker     │  │
│           │              └──────────────────┘  │
│           │                       │            │
│           └───────────┬───────────┘            │
│              ┌────────▼────────┐               │
│              │ Load Balancer   │               │
│              │ - URL Map       │               │
│              │ - HTTPS Proxy   │               │
│              │ - Forwarding    │               │
│              └─────────────────┘               │
└────────────────────────────────────────────────┘
```

## Database Migrations

When `migration.enabled` is `true` and a database is configured, `CloudRunService` creates a `MigrationJob` that:

- Creates a Cloud Run v2 Job using the same Docker image as the main service
- Runs with the same VPC and database connectivity
- Inherits the service's environment variables, merged with any `environmentOverrides`
- **Executes automatically** during `pulumi up` via a dynamic resource (`CloudRunJobExecution`)
- **Blocks** the Cloud Run service from deploying until the migration completes
- **Re-runs** when the Docker image changes (the image URI is used as the trigger)

The migration job's status and log URI are available on the `migration` property:

```typescript
service.migration?.status  // execution status
service.migration?.logUri  // link to Cloud Logging
```
