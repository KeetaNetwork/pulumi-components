# Keeta/pulumi-components

## Upgrading to 2.0

The Pulumi packages are peer dependencies now, so your program and this library share one copy of each (two copies can break a Pulumi program).

1. Add these packages to your own `package.json`, in the version ranges below or newer within the same major version:
   - `@pulumi/pulumi` `^3.272.0`
   - `@pulumi/gcp` `^9.30.0`
   - `@pulumi/command` `^1.1.3`
   - `@pulumi/random` `^4.18.4`
   - `@pulumi/tls` `^5.2.3`
2. Run `npm dedupe` so that `npm ls @pulumi/pulumi` shows one version.
3. Run `pulumi preview`. Expect no resource changes from this step.

### Removed or changed in 2.0

- `OutputWrapped<T>` is removed from the package root (`import { OutputWrapped } from '@keetanetwork/pulumi-components'`). Use `pulumi.Input<T>` (or `pulumi.Output<T> | T`) instead.
- `src/hosts.ts` is deleted. Its `addSubjectAlternativeToHosts` was never exported from the package root; only a deep import of `dist/hosts` could reach it, and that import stops working. The function appended entries to `/etc/hosts`.
- `CloudBuild` no longer has an `accessToken` input (it was always `undefined` and unused).
- `gcp.databaseEnv` is exported (`buildDatabaseEnvVars`, `buildRedisEnvVars`), new in this release.
- `EnvManager.resolvedVariableOutput` throws for a variable that references an existing secret (`{ name, version }`) and names that variable. Before, it left the variable out and the container started without it. A `CloudRunService` with a MIG worker (`workerKind: 'mig'`) therefore fails when `environment` holds an existing-secret variable. Give the worker a plain value through `mig.environmentOverrides`, or use `workerKind: 'crwp'`, which reads Secret Manager. CRWP workers are not affected.
- `CloudRunService` throws `migration.enabled requires database` when `migration.enabled` is true without `database`. Before, the migration was silently skipped.
- Local Docker builds choose the digest of the repository in the image URI, and fail when `docker image inspect` lists none for it (it used the first `RepoDigests` entry). The secret file of a local build is written with mode `0600` (was `0700`).
- Remote builds with `secrets` write the secret file with `printf '%s'` instead of `echo`, so a value that starts with `-` or contains a backslash is no longer altered. The Cloud Build step changes, so on the first deploy the image is built again. The rebuilt image usually has a new digest, so the Cloud Run service rolls a new revision and the migration job runs again. Nothing is replaced. This applies only to remote builds with `secrets`.

## GCP

### StaticWebApp
Uploads a directory of static files to a bucket and serves it from a backend bucket. With `loadBalancer` it also creates the HTTPS load balancer, certificate and DNS records.
```js
const site = new keetapulumi.gcp.apps.StaticWebApp('my-site', {
	// Directory with the files to upload
	staticFilesPath: path.join(__dirname, 'static'),
	bucketConfig: { location: 'US' },

	// Optional: cache lifetimes in seconds and Cloud CDN
	cacheControl: { indexTTL: 10, assetsTTL: 86400, defaultTTL: 300 },
	cdn: { enabled: true },

	// Optional: without it only the backend bucket is created, for use in a bigger load balancer
	loadBalancer: { domain: 'www.example.com', dnsZoneId: 'my-zone', ssl: { domains: [ 'www.example.com' ] }}
});
```

### CloudRunService
A Cloud Run service with an image that is either given (`image.uri`) or built from a directory (`image.build`, locally with Docker or remotely with Cloud Build when `remote` is set). `database`, `kv`, `vpc`, `mig` and `migration` add Cloud SQL, Redis, a VPC with connector, a worker and a migration job. `migration.enabled` requires `database`.
```js
const backend = new keetapulumi.gcp.apps.CloudRunService('my-backend', {
	gcp: { project: 'my-project' },
	region: 'us-central1',

	image: {
		build: {
			directory: path.join(__dirname, 'app'),
			imageName: 'my-app',
			registryUrl: 'us-central1-docker.pkg.dev/my-project/my-repo',
			remote: {}
		}
	},

	database: { tier: 'db-f1-micro' },
	migration: { enabled: true, container: { entrypoint: [ 'node', 'dist/migrate.js' ] }},
	service: { cpuLimit: 1, memoryLimit: 512 }
});
```

### FullStackApp
A `StaticWebApp` frontend and a `CloudRunService` backend behind one HTTPS load balancer. Requests under `routing.apiPrefix` (default `/api`) go to the backend, the static paths go to the bucket. Pass `frontend: null` for a backend only.
```js
const app = new keetapulumi.gcp.apps.FullStackApp('my-app', {
	loadBalancer: { domain: 'app.example.com', dnsZoneId: 'my-zone', ssl: { domains: [ 'app.example.com' ] }},
	frontend: { staticFilesPath: path.join(__dirname, 'static') },
	backend: { /* the arguments of CloudRunService */ },
	routing: { apiPrefix: '/api' }
});
```

### Cloud Run Env Manager
```js
new keetapulumi.cloudrun.EnvManager('mycloudrun-env', {
	variables: {
		PLAINTEXT_VARIABLE: 'Hello',
		PLAINTEXT_VARIABLE_TWO: { value: 'Hello', secret: false },
		SECRET_VARIABLE: { value: pulumi.random(), secret: true }
	},

	// serviceAccount/secretRegionName are optional
	// These both must be defined when you have one or more secrets
	// The service account is used to grant read access to the secrets that are being created
	serviceAccount: pulumi.interpolate`serviceAccount:${new gcp.serviceaccount.Account().email}`,
	secretRegionName: 'us-east1'
}, { provider });
```

## Docker
`DockerImage` builds with local Docker, or with Cloud Build when `serviceAccount`, `bucket` and `provider` are all given.
```js
const image = new keetapulumi.docker.DockerImage('mydockerimage', {
	// Docker image name
	imageName: 'my-app',

	// Registry to push image to
	registryUrl: 'gcr.io/xyz',

	versioning: {
		type: 'FILE', // 'FILE' | 'PLAIN' | 'GIT'

		// If type is FILE, specify a path to generate a hash from
		fromFile: './path/to/file'

		// If type is PLAIN, use `value: '0.0.0'` instead.
		// If type is GIT, use `directory: './path/to/repo'` and an optional `commitID`.
	},

	// Docker --build-arg's
	buildArgs: {
		ARG_TO_PASS: 'node16'
	},

	// Directory to build, or `{ type: 'DIRECTORY', directory, dockerfilePath?, excludePatterns? }`
	buildDirectory: './path/to/app',

	// Optional `--platform` value to pass to docker
	platform: 'linux/amd64',

	// Optional `--target` value to pass to docker
	buildTarget: 'production'
});

// The image with its digest, usable as a Cloud Run image
image.uri;

// Generate an identifier from a specific path
keetapulumi.docker.getFileResourceIdentifier('/path/to/file') // -> string
```

## Sleeper
```js
const vpc = new gcp.vpc();

const sleeper = keetapulumi.sleeper.makeSleeper('vpc-sleeper', vpc, 30);

// Will wait 30 seconds after VPC deletion to delete
const vpcconnector = new gcp.vpcaccess.connector('needs-sleeper', { ... }, { parent: sleeper })
```

### Types
```js
// Either T, or the pulumi wrapped version of T
type OutputWrapped<T> = pulumi.Output<T> | T;
```
### Utils 

```js
// Normalize a name to be used within a deployment
keetapulumi.utils.normalizeName('incorrect.NAME_valUE') // incorrect-name-value

const resp = await keetapulumi.utils.promisifyExec('tar', ['-xgf']);
/**
 * resp = {
 *  exitCode: 0,
 *  stdout: string[],
 *  stderr: string[]
 * }
 */
```
