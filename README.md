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
- `EnvManager.resolvedVariableOutput` throws for a variable that references an existing secret (`{ name, version }`) and names that variable. Before, it left the variable out and the container started without it. A `CloudRunService` with a MIG worker (`workerKind: 'mig'`) therefore fails when `environment` holds an existing-secret variable. Give the worker a plain value through `mig.environmentOverrides`, or use `workerKind: 'crwp'`, which reads Secret Manager. CRWP workers are not affected.
- `CloudRunService` throws a `CloudRunServiceArgsError` (`migration.enabled requires database`) when `migration.enabled` is true without `database`. Before, the migration was silently skipped.
- Local Docker builds choose the digest of the repository in the image URI, and fail when `docker image inspect` lists none for it (it used the first `RepoDigests` entry). The secret file of a local build is written with mode `0600` (was `0700`).
- Docker build contexts follow `.dockerignore` (and `excludePatterns`, which now match at any depth, as the `tar --exclude` patterns they replace did). A directory is versioned (`versioning: { type: 'FILE' }`) by the files that make up its build context, so the image tag changes once, on the first deploy after the upgrade, for every image with `versioning.type` `FILE` and a directory in `fromFile`. The image is built and pushed again under the new tag and the service rolls a new revision; after that the tag only changes when a file that Docker receives changes. Images with `PLAIN` or `GIT` versions keep their tag.
- `DirTarballArchive` (and so `RemoteDockerImage`) finds its cached tarball by the contents of the build context, not by the `cacheID`. Passing a `cacheID` now only keeps the tarball for reuse. A changed source is never given an older tarball.
- Local builds run `docker build` inside the build directory and pass `-f <dockerfilePath>` relative to it, so the arguments no longer contain a temporary path. A local build from a `DIRECTORY` or `GIT` source used to count as changed on every `pulumi up`, because its temporary build directory is a new input each time; it now only rebuilds when the image URI, build arguments, cache image or tags change.
- `MigrationJob` executions (`CloudRunJobExecution`) now run again only when `trigger` changes or the job is another job (its `jobName`, `projectId` or `region` changed). The execution keeps its inputs in its state for this; a state from 1.0.95 has none, so the first deploy after the upgrade runs the migration once more.
- New runtime dependency: `@balena/dockerignore` (exact version `1.0.2`).
- Secret environment variables (`{ value, secret: true }`) are pinned to a Secret Manager version. A service, job or worker pool used to read `latest`, so a new secret value did not start a new revision. Now the version number of the `SecretVersion` is part of the container's environment, and a changed value creates a new version, rolls a new revision and then disables the superseded version (`deletionPolicy: 'DISABLE'`, was `retainOnDelete`). On the first deploy after the upgrade every service, job and worker pool with a secret variable gets one new revision, with no change of value. The `SecretVersion` update itself is in place and no URN changes.
  - Versions that were left behind by `retainOnDelete` are not in the Pulumi state any more, so Pulumi does not touch them and they stay enabled. After the first deploy of the new release, find the version each service, job and worker pool now names (`gcloud run services describe <service> --region <region> --project <project>`), list the enabled versions with `gcloud secrets versions list <secret> --project <project> --filter="state=ENABLED"`, and disable every other one with `gcloud secrets versions disable <version> --secret <secret> --project <project>`. Never disable the version a revision names: its next instance would not start. Wait for the first deploy, because a value changed in that same deploy leaves one more version enabled.
  - A version added by hand (outside Pulumi) is no longer read, because each container names its version.
  - A rollback through Pulumi (deploying the older value again) needs no step. Rolling back to an older Cloud Run revision (or an older job) by hand needs the version that revision names to be enabled again: `gcloud secrets versions enable <version> --secret <secret> --project <project>`. A disabled version cannot be read, so the old revision fails to start until you do.
  - A disabled version is not destroyed: its value stays recoverable (`gcloud secrets versions enable`) until you purge it. To purge a compromised value, `gcloud secrets versions destroy <version> --secret <secret> --project <project>` the disabled version (this cannot be undone, and a revision that still names it will not start).
- Remote builds with `secrets` write the secret file with `printf '%s'` instead of `echo`, so a value that starts with `-` or contains a backslash is no longer altered. The Cloud Build step changes, so on the first deploy the image is built again. The rebuilt image usually has a new digest, so the Cloud Run service rolls a new revision and the migration job runs again. Nothing is replaced. This applies only to remote builds with `secrets`.

- `CloudRunService` reads its arguments once, in `parseCloudRunServiceArgs`, and rejects invalid ones with `CloudRunServiceArgsError` (an `Error`; exported from `gcp.apps`), before it registers anything. It rejects an `image` with both `uri` and `build` or with neither (the `image` type now forbids both), a Cloud Run worker pool (`crwp`) with `enableSSH` or `cosImage`, `mig` and `worker` together, and `migration.enabled` without `database`.
- `CloudRunService` has a new `worker` argument, and `mig` is deprecated: it still works for the 2.0 line, is translated into `worker`, and logs one warning (`pulumi.log.warn`) per `CloudRunService` that has an enabled `mig`. Move to `worker`; the resources and their URNs do not change:
  - `mig: { enabled: true, ...options }` becomes `worker: { kind: 'mig', ...options }`
  - `mig: { enabled: true, workerKind: 'crwp', ...options }` becomes `worker: { kind: 'crwp', ...options }` (a `crwp` worker has no `cosImage`, `enableSSH` or `diskSizeGb`; the type forbids them)
  - `mig: { enabled: false }` becomes no `worker` (remove the key)
  - Give either `mig` or `worker`, not both.
- New optional `CloudRunService` arguments, each defaulting to the value 1.0.95 used: `database.version` (`'POSTGRES_14'`), `database.queryStringLength` (`4500`), `vpc.connector.minInstances` and `maxInstances` (`2` and `3`), `vpc.psaPrefixLength` (`16`), `image.build.remote.timeoutSeconds` (`28800`) and `worker.diskSizeGb` (`50`, `mig` workers). Run `pulumi preview` before you change `vpc.psaPrefixLength` (it replaces the private service access range that the database peering uses), `vpc.connector` or `database.version` on an existing stack: they can replace a resource (the range, the connector) or upgrade the database, depending on the provider. `PostgresCloudSQL` has a new `databaseVersion` option and `ContainerMIG` a new `diskSizeGb` option.
- `ContainerMIG` and `ContainerCloudRun` take `pulumi.ComponentResourceOptions` as their third argument (they took `CustomResourceOptions`, which a component never used). `ContainerMIG` is regional when `zone` is absent and zonal when it is given. A `zone` key that is present but `undefined` (for example `zone: config.get('zone')`) keeps the zonal group of 1.0.95, in the default zone of the provider, and logs one warning: in 3.0 it will mean regional, so omit the key (or set a zone) to choose.
- The default values of the GCP components are in one module, `src/packages/gcp/defaults.ts` (`CLOUD_RUN_SERVICE_DEFAULTS`, `POSTGRES_DEFAULTS`, `BUILD_DEFAULTS`, `CONTAINER_DEFAULTS`, `MIGRATION_DEFAULTS`). The objects are frozen (the module is not exported from the package root). Their values are those of 1.0.95, so no resource changes.
- Resources of the components have a component as their parent now, not a sibling resource. The URNs of the moved resources change and each one carries one alias for its 1.0.95 URN, so when the provider stays the same, `pulumi up` moves them in the state without replacing anything (read `pulumi preview` first and expect only moves; the next-but-one bullet says when a resource is replaced):
  - `StaticWebApp`: the bucket, its viewer binding, the files and the backend bucket (they had no parent); the HTTP redirect URL map, proxy and forwarding rules of the load balancer (they were children of the URL map).
  - `CloudRunService`: the Docker image (no parent), the invoker binding, the network endpoint group and the backend service (children of the service and the endpoint group).
  - `MigrationJob`: the execution. `PostgresCloudSQL`: the database, the user, the replicas and the peering connection. `EnvManager`: the secret versions and their IAM bindings.
  - Cleanup that the old parent carried is kept with `deletedWith` (the endpoint group with the service, secret versions and bindings with their secret), and a replica waits for its master with `dependsOn`. The network chain stays where it is for now.
- `CloudRunService` has one owner for its service account and for the project roles it grants: a `ServiceIdentity` component (`Keeta:GCP:ServiceIdentity`, named `<name>-identity`). The service account (`<name>-sa`), the log writer grant (`<name>-log-writer`) and the Cloud SQL client grant (`<name>-cloudsql-client`) are its children now, each with one alias for its 1.0.95 URN, so `pulumi up` moves them in the state and replaces nothing. The identity grants nothing to a service account that you pass (`service.serviceAccount`), and `service.grantIAMRoles: false` still turns its grants off. In both cases the worker and the migration job grant their own roles to the account, as before. `changeProjectIAMPolicy` is called once for each role, by the identity.
  - A `CloudRunService` with a `worker` is granted `roles/monitoring.metricWriter` once, by the identity (`<name>-metric-writer`, a new resource), together with `roles/logging.logWriter`. The worker (`ContainerMIG`, `ContainerCloudRun`) and the `MigrationJob` receive the identity (an internal `identity` option, `{ email, grants }`, set by `CloudRunService`) and grant nothing for themselves.
  - The grants that the worker and the migration made before (`<name>-mig-iam-logging`, `<name>-mig-iam-metric`, `<name>-crwp-iam-logging`, `<name>-crwp-iam-metric`, `<name>-migration-cloudsql-client`) stay in your state at the URN they have. Where the identity grants the same role (an account that the library creates, `grantIAMRoles` not `false`) they now have `retainOnDelete: true`: Pulumi never deletes them, so no project role is revoked while the identity makes the same bindings under its own names. They are harmless duplicates, and they go away in 3.0. To remove one earlier, safely, run `pulumi state delete <urn>` (it removes the resource from the state and leaves the binding in GCP; do not delete the resource with `pulumi destroy --target` or by removing it from the program, because that revokes the role). Where the identity does not grant the role (you pass `service.serviceAccount`, or `grantIAMRoles` is `false`), the worker and the migration grant it for themselves exactly as in 1.0.95: a normal grant, revoked with the component, or a call of your `changeProjectIAMPolicy`. A `ContainerMIG`, `ContainerCloudRun` or `MigrationJob` that you create yourself, without `identity`, grants for itself as before.
  - `changeProjectIAMPolicy` is called once for each role that the identity grants, and no longer by the worker or the migration for that role: an app with a database, a migration and a worker calls it 3 times (log writer, metric writer, Cloud SQL client) where 1.0.95 called it 5 times (the log writer and the Cloud SQL client twice each, the metric writer once). A hook that creates one resource for each call therefore loses the duplicates on upgrade, and deleting a duplicate grant revokes the role if nothing else grants it: make sure that your hook is idempotent for a (role, member), and read `pulumi preview` before you deploy. For a caller account or `grantIAMRoles: false` the hook is still called for the roles of the worker and the migration, as before.
- `CloudRunService` has one environment: `<name>-env` (an `EnvManager`) holds the database, Redis and `environment` variables and their managed secrets, and the service, the migration job and the worker read views of it (`EnvManager.view(overrides)`, with `cloudRun`, `cloudRunJob` and `resolvedForVm`; a view creates no resource). `MigrationJob` has a new optional `env` option for this; without it (standalone use) it keeps its own manager. The worker now also gets the Redis variables (`MC_REDIS_*`), which it did not before.
  - One-time rollout: the managers `<name>-mig-env` (the worker) and `<name>-migration-env` (the migration job) leave the state, with their managed secrets, secret versions and bindings (for example `<name>-migration-env-mc-psql-db-password`). The first `pulumi up` after the upgrade deletes those secrets from Secret Manager and points the migration job (a new revision) and the worker at the secrets of `<name>-env`; the service already read those. Pulumi updates the job and the worker before it deletes the old secrets. Run `pulumi preview` first and expect these deletes and nothing else. Anything outside the library that reads one of the removed secrets by name (`<name>-mig-env-*`, `<name>-migration-env-*`) loses it: point it at `<name>-env-*`. The worker of an app with Redis gets the Redis variables, so its container declaration changes (a `mig` worker restarts its instances).
  - A binding that a removed manager made for a secret that you own (`service.environment` with `{ name, version }`) is the same grant as the binding of `<name>-env`. Deleting it would remove the member from the secret in GCP and take away the access that the surviving binding relies on, so it is not deleted: `<name>-mig-env-non-managed-<variable>-iam-binding` and `<name>-migration-env-non-managed-<variable>-iam-binding` stay in the state as children of `<name>-env`, with `retainOnDelete: true` and the alias for their old URN. The retained copies only stop the upgrade from revoking the access. A `pulumi destroy` deletes the live binding of `<name>-env`, which revokes the access on the secret. The retained copies go away in 3.0, and `pulumi state delete <urn>` removes one earlier, safely.
  - An account change (a different `service.serviceAccount`) removes the old account's access to the secret through the live binding of `<name>-env`. The retained copies only keep their URN until 3.0.
  - The variables of a virtual machine worker (`kind: 'mig'`) are not read from Secret Manager: they sit in the metadata of the instance template (`gce-container-declaration`), in plain text for anyone who can read the template in GCP. A literal marked `secret: true` is a secret output in your Pulumi state, so the state masks it, but the VM still has the value. A secret that you own (`{ name, version }`) cannot be given to a VM worker, and the constructor throws and names the variable.
  - Turning `service.grantIAMRoles` off on a stack with a worker or a migration revokes those roles from the account: the identity's grant is deleted, and the copy of the worker or the migration stays in your state, so Pulumi still believes that the binding exists. Run `pulumi refresh` and then `pulumi up`: the refresh notices the missing binding, and the update creates it again from the worker and the migration, as in 1.0.95.
  - Changing the service account of an app (a different `service.serviceAccount`) removes the roles of the old account through the identity's grant, which is live. The retained copies only keep their URN until 3.0.
- `gcp.lb.createHttpRedirect` takes `{ parent, oldParent? }` as its third argument, in place of optional `CustomResourceOptions`. `parent` is required. Pass `oldParent` (the URN of the redirect's 1.0.95 parent) to keep its resources at their old URNs through aliases.
- `CloudRunService` no longer creates a `<name>-build-provider` resource for a remote build, so that resource leaves the state. Every resource that sat at the root of the stack in 1.0.95 is a child of its component now, so it uses the `providers` that you pass to the component (before, it used the default provider): the `StaticWebApp` bucket, its viewer binding, its files and its backend bucket (also when they come through a `FullStackApp`), and the `CloudRunService` Docker image with its IAM grants. If your provider config differs from the default one (a different project, for example), Pulumi replaces them, and the site bucket holds your data: run `pulumi preview` for every consumer before you deploy, and do not deploy a replace of the bucket. Upgrade first, then move your own components: change the `providers` you pass in a later deployment, not in the one that upgrades the library.
- `CloudBuild`, `LocalDockerImageBuilder` and `CloudRunJobExecution` get an `auth` input that holds the project and the account that your provider impersonates, so a build or a migration runs as the same identity as the rest of the deployment. It never holds a token or a key, and it never causes a rebuild or a new execution. When your provider impersonates a service account (`impersonateServiceAccount`, or `gcp:impersonateServiceAccount` in the stack configuration when you pass no GCP provider), builds, uploads, migrations and pushes run as that account, so it needs the permissions that those steps use: Cloud Build (`cloudbuild.builds.create`, and `iam.serviceAccounts.actAs` on the build service account), write access to the source bucket (`storage.objects.create`), Secret Manager (`secretmanager.secrets.create`, `secretmanager.secrets.setIamPolicy`, `secretmanager.versions.add`, `secretmanager.secrets.delete`, for builds with `secrets`), `run.jobs.run` for migrations, and Artifact Registry writer (`roles/artifactregistry.writer`) for local pushes. Your own identity needs `iam.serviceAccounts.getAccessToken` on it (`roles/iam.serviceAccountTokenCreator`).

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
A Cloud Run service with an image that is either given (`image.uri`) or built from a directory (`image.build`, locally with Docker or remotely with Cloud Build when `remote` is set). `database`, `kv`, `vpc`, `worker` and `migration` add Cloud SQL, Redis, a VPC with connector, a worker and a migration job. `migration.enabled` requires `database`.
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
