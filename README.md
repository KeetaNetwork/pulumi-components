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

- `EnvManager.resolvedVariableOutput` throws for a variable that references an existing secret (`{ name, version }`) and names that variable. Before, it left the variable out and the container started without it. A `CloudRunService` with a MIG worker (`workerKind: 'mig'`) therefore fails when `environment` holds an existing-secret variable. Give the worker a plain value through `mig.environmentOverrides`, or use `workerKind: 'crwp'`, which reads Secret Manager. CRWP workers are not affected.
- `CloudRunService` throws `migration.enabled requires database` when `migration.enabled` is true without `database`. Before, the migration was silently skipped.
- Local Docker builds choose the digest of the repository in the image URI, and fail when `docker image inspect` lists none for it (it used the first `RepoDigests` entry). The secret file of a local build is written with mode `0600` (was `0700`).
- Remote builds with `secrets` write the secret file with `printf '%s'` instead of `echo`, so a value that starts with `-` or contains a backslash is no longer altered. The Cloud Build step changes, so on the first deploy the image is built again. The rebuilt image usually has a new digest, so the Cloud Run service rolls a new revision and the migration job runs again. Nothing is replaced. This applies only to remote builds with `secrets`.

## GCP

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
```js
new keetapulumi.docker.Image('mydockerimage', {
	// Docker image name
	imageName: 'my-app',

	// Registry to push image too
	registryUrl: 'gcr.io/xyz'.

	versioning: {
		type: 'FILE' | 'PLAIN'

		// If type is FILE, specify a path to generate a hash from
		fromFile: './path/to/file',

		// If type is PLAIN specify a version identifier
		value: '0.0.0',
	}

	// Docker --build-arg's
	buildArgs: { 
		ARG_TO_PASS: 'node16'
	},

	// Path of directory to build
	buildDirectory: string;

	// Optional path to dockerfile
	dockerfile: string;

	// Optional `--platform` tag to pass to docker
	platform: 'linux/amd64';

	// Optional - Additional arguments to pass to docker build
	additionalArguments: []
});

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
