# GCP Application Deployment Components

This module provides three composable Pulumi components for deploying applications to Google Cloud Platform.

## Components

### 1. StaticWebApp (SPA)

Deploys static files to a GCS bucket with optional HTTPS load balancer.

**Use cases:**
- Web Wallet (standalone SPA with load balancer)
- Frontend portion of full-stack apps (without load balancer)

**Features:**
- Uploads static files to GCS bucket
- Configurable cache control (index.html, assets, other files)
- Optional HTTPS load balancer with SSL certificate
- DNS record creation support
- SPA routing (all paths redirect to index.html)

**Example - Standalone SPA:**
```typescript
import * as components from '@keetanetwork/pulumi-components';

const webWallet = new components.gcp.apps.StaticWebApp('web-wallet', {
    staticFilesPath: './dist',
    fileFilter: (file) => file !== '.done',
    cacheControl: {
        indexTTL: 10,      // 10 seconds for index.html
        assetsTTL: 86400,  // 1 day for hashed assets
        defaultTTL: 300    // 5 minutes for other files
    },
    loadBalancer: {
        domain: 'wallet.example.com',
        dnsZoneId: 'my-dns-zone',
        ssl: {
            domains: ['wallet.example.com']
        },
        routing: {
            staticPaths: ['/assets/', '/icons/'],
            staticFiles: ['/favicon.svg']
        }
    }
});
```

**Example - For composition (no load balancer):**
```typescript
const frontend = new components.gcp.apps.StaticWebApp('frontend', {
    staticFilesPath: './client/dist',
    cacheControl: {
        indexTTL: 10,
        assetsTTL: 86400
    }
    // No loadBalancer - will be used in FullStackApp
});
```

### 2. CloudRunService (Backend)

Deploys a containerized backend service to Cloud Run with optional PostgreSQL database.

**Use cases:**
- Footprint KYC Anchor (backend-only service)
- EVM Asset Anchor (backend with database)
- Bridge Anchor (backend with database)
- Backend portion of full-stack apps

**Features:**
- Cloud Run service deployment
- Docker image building or URI-based deployment
- Optional PostgreSQL database with VPC peering
- Environment variable management with secrets
- Automatic VPC and VPC connector creation
- Service account creation and IAM setup
- Exposes backend service for load balancer integration
- Optional database migration via Cloud Run Job
- Optional MIG worker for background tasks

**Example - Backend only:**
```typescript
const kycAnchor = new components.gcp.apps.CloudRunService('kyc-anchor', {
    gcp: {
        project: 'my-project',
        changeProjectIAMPolicy: myIAMPolicyFunction
    },
    region: 'us-central1',
    image: {
        build: {
            directory: './src',
            imageName: 'kyc-anchor',
            target: 'runner',
            nodeImage: 'node:20-alpine',
            secrets: {
                GITHUB_TOKEN: githubToken
            }
        }
    },
    environment: {
        APP_SEED: { value: seed, secret: true },
        APP_CERTIFICATE: certificate,
        APP_PUBLIC_URL: 'https://kyc.example.com'
    },
    database: {
        tier: 'db-f1-micro',
        queryInsights: false
    },
    migration: {
        enabled: true,
        environmentOverrides: {
            RUN_MIGRATIONS: 'true',
            MIGRATION_MODE: 'apply'
        },
        cpuLimit: 1,
        memoryLimit: 512,
        taskTimeout: 600
    }
});
```

### 3. FullStackApp (SPA + Backend)

Combines StaticWebApp and CloudRunService with a unified HTTPS load balancer.

**Use cases:**
- Demo FX Anchor (SPA + API)
- Demo KYC Provider (SPA + API + database)
- Faucet (SPA + API + database)

**Features:**
- Composes StaticWebApp and CloudRunService
- Unified load balancer with routing rules
- Routes API traffic to backend, static content to frontend
- Configurable API prefix
- SSL certificate management
- DNS record creation

**Example - Full-stack application:**
```typescript
const demoFxAnchor = new components.gcp.apps.FullStackApp('demo-fx', {
    loadBalancer: {
        domain: 'fx.example.com',
        dnsZoneId: 'my-dns-zone',
        ssl: {
            domains: ['fx.example.com']
        },
        routing: {
            staticPaths: ['/assets/'],
            staticFiles: ['/favicon.svg']
        }
    },
    frontend: {
        staticFilesPath: './client/dist',
        fileFilter: (file) => file !== '.done',
        cacheControl: {
            indexTTL: 10,
            assetsTTL: 86400
        }
    },
    backend: {
        gcp: {
            project: 'my-project'
        },
        region: 'us-central1',
        image: {
            build: {
                directory: './api',
                imageName: 'demo-fx-api',
                nodeImage: 'node:20-alpine'
            }
        },
        environment: {
            APP_SEED: { value: seed, secret: true },
            APP_CLIENT_URL: 'https://fx.example.com'
        },
        database: {
            tier: 'db-f1-micro'
        },
        migration: {
            enabled: true,
            environmentOverrides: {
                RUN_MIGRATIONS: 'true'
            }
        }
    },
    routing: {
        apiPrefix: '/api',  // Routes /api/** to backend
        staticPaths: ['/assets/', '/icons/'],
        staticFiles: ['/favicon.svg']
    }
});

// Access components:
// - demoFxAnchor.frontend (StaticWebApp instance)
// - demoFxAnchor.backend (CloudRunService instance)
// - demoFxAnchor.backend.migrationJob (Cloud Run Job for migrations)
// - demoFxAnchor.ips (load balancer IPs)
```

## Composition Pattern

The components are designed to be composable:

```
┌─────────────────────────────────────────────────┐
│ FullStackApp                                    │
│                                                 │
│  ┌────────────────┐      ┌──────────────────┐  │
│  │ StaticWebApp   │      │ CloudRunService  │  │
│  │ (frontend)     │      │ (backend)        │  │
│  │                │      │                  │  │
│  │ - GCS Bucket   │      │ - Cloud Run      │  │
│  │ - Backend      │      │ - Database       │  │
│  │   Bucket       │      │ - VPC            │  │
│  └────────────────┘      └──────────────────┘  │
│           │                       │             │
│           └───────────┬───────────┘             │
│                       │                         │
│              ┌────────▼────────┐                │
│              │ Load Balancer   │                │
│              │ - URL Map       │                │
│              │ - HTTPS Proxy   │                │
│              │ - Forwarding    │                │
│              └─────────────────┘                │
└─────────────────────────────────────────────────┘
```

## Migration Guide

### From existing deployments:

**Web Wallet → StaticWebApp:**
```typescript
// Old: Custom implementation
// New:
new components.gcp.apps.StaticWebApp('wallet', {
    staticFilesPath: webDir,
    loadBalancer: { domain, ssl: { domains } }
});
```

**Footprint KYC Anchor → CloudRunService:**
```typescript
// Old: Custom implementation
// New:
new components.gcp.apps.CloudRunService('kyc', {
    gcp: { project },
    region: mainRegion,
    image: { build: { directory, imageName } },
    environment: { ... },
    database: { tier: dbSize }
});
```

**Demo KYC Provider → FullStackApp:**
```typescript
// Old: Custom implementation with separate frontend/backend
// New:
new components.gcp.apps.FullStackApp('demo-kyc', {
    loadBalancer: { domain, ssl },
    frontend: { staticFilesPath: clientDir },
    backend: {
        image: { build: { directory: apiDir } },
        database: { tier: dbSize }
    }
});
```

## Benefits

1. **Reduced Code Duplication**: Common patterns extracted into reusable components
2. **Composability**: Components can be used standalone or composed
3. **Type Safety**: Full TypeScript support with comprehensive types
4. **Consistency**: All deployments follow the same patterns
5. **Maintainability**: Updates to components benefit all users
6. **Flexibility**: Extensive configuration options for customization

## Database Migrations

The `CloudRunService` and `FullStackApp` components support optional database migrations using Cloud Run Jobs. This allows you to run database migrations using the same Docker image as your application, but with different environment variables to trigger migration mode.

### How it works

When `migration.enabled` is set to `true`, the component creates a Cloud Run Job that:
- Uses the same Docker image as your main service
- Runs with the same VPC and database connectivity
- Merges base environment variables with migration-specific overrides
- Can be triggered manually or as part of your deployment pipeline

### Configuration

```typescript
const service = new components.gcp.apps.CloudRunService('my-service', {
    // ... other config ...
    database: {
        tier: 'db-f1-micro'
    },
    migration: {
        enabled: true,
        // Override environment variables for migration
        environmentOverrides: {
            RUN_MIGRATIONS: 'true',
            MIGRATION_MODE: 'apply',
            // Any other migration-specific variables
        },
        // Optional resource limits
        cpuLimit: 1,           // CPU cores (default: 1)
        memoryLimit: 512,      // Memory in MB (default: 512)
        taskTimeout: 600       // Timeout in seconds (default: 600)
    }
});

// Access the migration job
const migrationJobName = service.migrationJob?.name;
```

### Running migrations

The Cloud Run Job is created but not automatically executed. You can run it:

**Via gcloud:**
```bash
gcloud run jobs execute <job-name> --region=<region>
```

**Via Pulumi automation:**
```typescript
import { runJobExecution } from './migration-runner';

await runJobExecution(service.migrationJob?.name, region);
```

**Via CI/CD pipeline:**
Add a step in your deployment pipeline to execute the job after the infrastructure is deployed.

### Best practices

1. **Use environment variables**: Configure your application to detect migration mode via environment variables (e.g., `RUN_MIGRATIONS=true`)
2. **Idempotent migrations**: Ensure migrations can be run multiple times safely
3. **Test migrations**: Run migrations in staging before production
4. **Monitor execution**: Check job execution logs for errors
5. **Resource allocation**: Adjust CPU/memory based on migration complexity
