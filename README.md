# Keeta/pulumi-components

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
	serviceAccount: new gcp.serviceaccount.Account(),
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

## Misc

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
