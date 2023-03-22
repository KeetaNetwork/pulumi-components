import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn as childProcessSpawn } from 'child_process';

import { promisifyExec, hash } from '../utils';
import type { PublicInterface } from '../utils';
import type { UnwrapDeepInput } from '../types';
import CloudBuild from './gcp/cloudbuild';
import * as Tarball from './tarball';
import { GCP_COMPONENT_PREFIX } from './gcp/constants';

function updateHashWithSingleFile(fullPath: string, hashState: crypto.Hash) {
	hashState.update(fs.readFileSync(fullPath));
}

function updateHashWithMultipleFiles(filePath: string, hashState: crypto.Hash) {
	if (fs.statSync(filePath).isFile()) {
		updateHashWithSingleFile(filePath, hashState);
		return;
	}

	const info = fs.readdirSync(filePath, { withFileTypes: true });

	for (const item of info) {
		const fullPath = path.join(filePath, item.name);
		if (item.isFile()) {
			updateHashWithSingleFile(fullPath, hashState);
			continue;
		}

		if (item.isDirectory()) {
			updateHashWithMultipleFiles(fullPath, hashState);
		}
	}
}

export function getFileResourceIdentifier(computeFrom: string): string {
	const hashState = crypto.createHash('sha1');

	updateHashWithMultipleFiles(computeFrom, hashState);

	return hashState.digest('hex').substring(0, 9);
}

interface GCPDockerImageInput {
	/**
	 * Registry URL to create the image in
	 */
	registryUrl: string;

	/**
	 * Image name to push and pull from the registry
	 */
	imageName: string;

	/**
	 * If provided, a tag to pull the image from the registry
	 * to use as a cache
	 */
	cacheFromTag?: string;

	/**
	 * Additional tags to push
	 *
	 * This is useful for pushing a tag to pull from for caching purposes
	 */
	tags?: string[];

	/**
	 * How to generate the tag for the image:
	 *
	 *   FILE: Provide a file or directory and generate a hash from the contents
	 *   PLAIN: Provide a string to use as the tag
	 *   GIT: Provide a directory and optional commit ID to use as the tag
	 */
	versioning: {
		type: 'FILE',
		fromFile: string;
	} | {
		type: 'PLAIN',
		value: string;
	} | {
		type: 'GIT';
		directory: string;
		commitID?: string;
	};

	/**
	 * Additional arguments to pass to as "build-args"
	 */
	buildArgs?: { [key: string]: string | undefined };

	/**
	 * Source to build from, either a directory or a git
	 * working copy and optional commit
	 */
	buildDirectory: string | {
		type: 'GIT';
		directory: string;
		commitID?: string;
	};

	/**
	 * Platform to build image for
	 */
	platform?: string;

	/**
	 * Secrets to set Environment Variables for
	 */
	secrets?: {
		[envName: string]: pulumi.Input<string>;
	}
}

type GCPDockerLocalImageInput = GCPDockerImageInput;
interface GCPDockerRemoteImageInput extends GCPDockerImageInput {
	/**
	 * Service account to use for performing the CloudBuild,
	 * this must have access to pull and push
	 */
	serviceAccount: Pick<gcp.serviceaccount.Account, 'email'>;

	/**
	 * Google Cloud Storage Bucket to use for storing the
	 * tarball of the source code.  The service account must
	 * have access to read and write to this bucket
	 */
	bucket: Pick<gcp.storage.Bucket, 'name'>;

	/**
	 * Google Cloud Provider to use for creating the CloudBuild
	 * and other resources
	 */
	provider: gcp.Provider | Pick<gcp.Provider, 'project'>;
}

abstract class BaseDockerImage extends pulumi.ComponentResource {
	private static AwaitingOutput: { [rawUrl: string]: Promise<string | pulumi.Output<string>> } = {};

	/**
	 * The fully qualified URL to the built image (<image>@<sha256:hash>)
	 */
	readonly uri: pulumi.Output<string>;

	/**
	 * The image name (<image>:<tag>)
	 */
	readonly image: string;

	/**
	 * The image base name (<image>)
	 */
	readonly imageBase: string;

	/**
	 * Input cache image name (if provided)
	 */
	readonly imageCache?: string;

	abstract _checkImage(prefix: string, imageURI: string, input: GCPDockerLocalImageInput | GCPDockerRemoteImageInput): Promise<string>;
	abstract _checkImage(prefix: string, imageURI: string, input: GCPDockerLocalImageInput | GCPDockerRemoteImageInput): Promise<pulumi.Output<string>>;
	abstract _checkImage(prefix: string, imageURI: string, input: GCPDockerLocalImageInput | GCPDockerRemoteImageInput): Promise<string | pulumi.Output<string>>;

	protected getDockerBuildArgs(input: GCPDockerImageInput) {
		const args: string[] = [];

		if (this.imageCache) {
			args.push('--cache-from', `${this.imageCache}`);
		}

		if (input.platform) {
			args.push('--platform', input.platform);
		}

		for (const [ key, value ] of Object.entries(input.buildArgs ?? {})) {
			args.push('--build-arg', `${key}=${value ?? ''}`);
		}

		return(args);
	}

	protected getDockerBuildTags(input: GCPDockerImageInput) {
		const tags: string[] = [];

		if (input.tags) {
			for (const tag of input.tags) {
				tags.push(`${this.imageBase}:${tag}`);
			}
		}

		return(tags);
	}

	constructor(prefix: string, input: GCPDockerImageInput, opts?: pulumi.CustomResourceOptions) {
		super(`${GCP_COMPONENT_PREFIX}:DockerImage`, prefix, {}, { ...opts });

		let forwardSlash = '';
		if (!input.registryUrl.endsWith('/')) {
			forwardSlash = '/';
		}

		let versionIdentifier: string;
		switch (input.versioning.type) {
			case 'FILE':
				versionIdentifier = `hash_${getFileResourceIdentifier(input.versioning.fromFile)}`;
				break;
			case 'PLAIN':
				versionIdentifier = input.versioning.value;
				break;
			case 'GIT':
				{
					const tarball = new Tarball.GitTarballArchive(input.versioning.directory, input.versioning.commitID);
					versionIdentifier = `git_${tarball.uniqueID}`;
				}
				break;
			default:
				throw new Error(`Invalid docker versioning input ${JSON.stringify(input.versioning)}`);
		}

		const imageBaseName = `${input.registryUrl}${forwardSlash}${input.imageName}`;
		this.imageBase = imageBaseName;

		const imageURI = `${imageBaseName}:${versionIdentifier}`;
		this.image = imageURI;

		if (input.cacheFromTag) {
			this.imageCache = `${imageBaseName}:${input.cacheFromTag}`;
		}

		if (BaseDockerImage.AwaitingOutput[imageURI] === undefined) {
			const imageInfo = this._checkImage(prefix, imageURI, input);

			BaseDockerImage.AwaitingOutput[imageURI] = imageInfo;
		}

		this.uri = pulumi.output(BaseDockerImage.AwaitingOutput[imageURI]);

		this.registerOutputs({ uri: this.uri });
	}

	/**
	 * Perform any cleanup required post-deployment
	 */
	abstract clean(): void;
}

export class LocalDockerImage extends BaseDockerImage {
	private cleanTmpDir?: string;
	private async getBuildDirectory(input: GCPDockerImageInput['buildDirectory']) {
		if (typeof input === 'string') {
			return input;
		}

		const tarball = new Tarball.GitTarballArchive(input.directory, input.commitID);
		const tarballPath = await tarball.path;

		const tmpDir = fs.mkdtempSync('/tmp/docker-build-');
		try {
			childProcessSpawn('tar', [ '-zxf', tarballPath, '-C', tmpDir ]);
		} catch {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			throw new Error(`Failed to extract tarball ${tarballPath} to ${tmpDir}`);
		}

		this.cleanTmpDir = tmpDir;

		return(tmpDir);
	}

	async _checkImage(_ignore_prefix: string, imageURI: string, input: GCPDockerImageInput): Promise<string>;
	async _checkImage(_ignore_prefix: string, imageURI: string, input: GCPDockerImageInput): Promise<pulumi.Output<string>>;
	async _checkImage(_ignore_prefix: string, imageURI: string, input: GCPDockerImageInput): Promise<string | pulumi.Output<string>> {
		let secretsDir: string | undefined;
		try {
			try {
				// Remove the local copy of the image
				await promisifyExec('docker', [ 'image', 'rm', imageURI ]);
			} catch {
				/* Ignore errors removing an image */
			}

			/*
			 * Pull the cache image if appropriate
			 */
			if (this.imageCache) {
				try {
					await promisifyExec('docker', [ 'pull', `${this.imageCache}` ]);
				} catch {
					/* Ignore errors attempt to pull cache image */
				}
			}

			/**
			 * Get the build directory from the input, which may
			 * require creating a temporary directory and extracting
			 * a tarball into it
			 */
			const buildDirectory = await this.getBuildDirectory(input.buildDirectory);

			/**
			 * Compute the arguments for "docker build"
			 */
			const buildArgs = [ '-t', imageURI, ...this.getDockerBuildArgs(input)];
			let env: NodeJS.ProcessEnv | undefined;

			/**
			 * Setup a socket for secrets for the build
			 */
			if (input.secrets) {
				secretsDir = fs.mkdtempSync('/tmp/docker-secrets-');

				/*
				 * Create a source-able script that exports the secrets
				 */
				const secretsFile = path.join(secretsDir, 'secrets.sh');
				const secretsScriptContents = (await Promise.all(Object.entries(input.secrets).map(async function([key, value]) {
					if (pulumi.Output.isInstance(value)) {
						value = value.get();
					} else if (typeof value !== 'string' && 'then' in value) {
						value = await value;
					}
					return(`export ${key}='${value}'`);
				}))).join('\n');

				fs.writeFileSync(secretsFile, secretsScriptContents, { mode: 0o700 });

				buildArgs.push('--secret', `id=secrets,src=${secretsFile}`);

				env = {};
				env['DOCKER_BUILDKIT'] = '1';
			}

			/*
			 * Run "docker build" to build the image
			 */
			await promisifyExec('docker', ['build', ...buildArgs, buildDirectory], env);

			/*
			 * Push the image
			 */
			await promisifyExec('docker', [ 'image', 'push', imageURI ]);

			/**
			 * Add the additional tags and push them
			 */
			for (const taggedImage of this.getDockerBuildTags(input)) {
				await promisifyExec('docker', [ 'tag', imageURI, taggedImage ]);
				await promisifyExec('docker', [ 'image', 'push', taggedImage ]);
			}

			const imageInfoJSON = await promisifyExec('docker', [ 'image', 'inspect', imageURI ]);
			const imageInfo = JSON.parse(imageInfoJSON.stdout.join('\n'));
			const imageDigest = imageInfo[0].RepoDigests[0];

			return(imageDigest);
		} catch (buildError) {
			console.log(`Failed to build local Docker image ${imageURI}:`, buildError);

			throw(buildError);
		} finally {
			this.clean();

			if (secretsDir) {
				fs.rmSync(secretsDir, { recursive: true, force: true });
			}
		}
	}

	clean() {
		const cleanDir = this.cleanTmpDir;
		if (cleanDir) {
			this.cleanTmpDir = undefined;
			fs.rmSync(cleanDir, { recursive: true, force: true });
		}
	}
}

/*
 * Produce a Docker image using Google Cloud Build
 *
 * The service account supplied is used to push/pull the image to/from the
 * repository, to create the tarball in the specified Bucket, and to run the
 * Cloud Build job.
 *
 * It needs access to a few project-level resources to work:
 *     - roles/logging.logWriter - to write logs
 *     - roles/cloudbuild.builds.builder - to run the build
 *     - roles/cloudbuild.serviceAgent - to run the build
 */
export class RemoteDockerImage extends BaseDockerImage implements PublicInterface<LocalDockerImage> {
	private localAsset?: Tarball.GitTarballArchive | Tarball.DirTarballArchive;
	private async getBuildTarball(input: GCPDockerImageInput['buildDirectory'], cacheID: string) {
		let tarball: Tarball.GitTarballArchive | Tarball.DirTarballArchive;
		if (typeof input === 'string') {
			tarball = new Tarball.DirTarballArchive(input, cacheID);
		} else {
			tarball = new Tarball.GitTarballArchive(input.directory, input.commitID);
		}

		this.localAsset = tarball;

		return(tarball);

	}

	async _checkImage(prefix: string, imageURI: string, input: GCPDockerRemoteImageInput): Promise<string>;
	async _checkImage(prefix: string, imageURI: string, input: GCPDockerRemoteImageInput): Promise<pulumi.Output<string>>;
	async _checkImage(prefix: string, imageURI: string, input: GCPDockerRemoteImageInput): Promise<string | pulumi.Output<string>> {
		/**
		 * Secrets
		 */
		const secrets = input.secrets || {};

		/**
		 * Cache ID based on the ImageURI, which includes the version
		 * info so if it changes the image will be rebuilt
		 */
		const cacheID = hash(imageURI, 32);

		/*
		 * Get project from provider
		 */
		const project = input.provider.project;

		/**
		 * Service account for build to run as
		 */
		const serviceAccount = input.serviceAccount;

		/**
		 * Name of the image, many resource names are based off this
		 */
		const name = input.imageName;

		/**
		 * Source tarball for the build, which will be uploaded to
		 * the bucket and passed to CloudBuild
		 */
		const source = await this.getBuildTarball(input.buildDirectory, cacheID);
		this.localAsset = source;

		/**
		 * If a provider is provided, use it for the child resources
		 */
		const childProvider = RemoteDockerImage.childProvider(input);

		const imageSourceObject = new gcp.storage.BucketObject(`${prefix}-cloudbuild-src`, {
			bucket: input.bucket.name,
			source: source
		}, {
			/*
			 * We keep a copy of the source in the bucket so that we can
			 * access it if needed, since the build output is also kept
			 */
			retainOnDelete: true,
			provider: childProvider
		});

		/**
		 * Steps to perform to build the image
		 */
		const steps: NonNullable<UnwrapDeepInput<ConstructorParameters<typeof CloudBuild>[1]['build']>['steps']> = [];

		/*
		 * Pull the cache image if it is specified
		 */
		if (this.imageCache) {
			steps.push({
				name: 'gcr.io/cloud-builders/docker',
				args: [
					'pull',
					this.imageCache
				],
				allowFailure: true
			});
		}

		/*
		 * Build the new image version
		 */
		steps.push({
			name: 'gcr.io/cloud-builders/docker',
			args: [
				'build',
				'-t',
				this.image,
				...this.getDockerBuildArgs(input),
				'.'
			],
			secretEnv: Object.keys(secrets)
		});

		/*
		 * Add all additional tags
		 */
		for (const taggedImage of this.getDockerBuildTags(input)) {
			steps.push({
				name: 'gcr.io/cloud-builders/docker',
				args: [
					'tag',
					this.image,
					taggedImage
				]
			});
		}

		const buildInfo = new CloudBuild(`${prefix}-build`, {
			gcpProvider: input.provider,
			build: {
				serviceAccount: pulumi.interpolate`projects/${project}/serviceAccounts/${serviceAccount.email}`,
				availableSecrets: {
					secretManager: Object.keys(secrets).map(function(secretName) {
						return({
							/* XXX: TODO: This isn't the secret version, it's just random data */
							versionName: secrets[secretName],
							env: secretName
						});
					})
				},
				images: [
					this.image,
					...this.getDockerBuildTags(input)
				],
				timeout: {
					/* XXX:TODO: Make this configurable */
					seconds: 8/* h */ * 60/* m */ * 60/* s */
				},
				steps: steps,
				options: {
					logging: 'CLOUD_LOGGING_ONLY',
					/* XXX:TODO: Make this configurable */
					machineType: 'E2_HIGHCPU_8',
					requestedVerifyOption: 'VERIFIED',
					sourceProvenanceHash: [
						CloudBuild.HashType.SHA256
					]
				},
				source: {
					storageSource: {
						bucket: imageSourceObject.bucket,
						object: imageSourceObject.outputName
					}
				}
			}
		}, { parent: this });

		/**
		 * Compute the image digest from the build results
		 */
		const image = buildInfo.results.apply(function(results) {
			if (results === undefined || results === null) {
				throw(new Error(`No results from build process for ${name}`));
			}

			if (!Array.isArray(results.images) || results.images.length === 0) {
				throw(new Error(`No images built while building ${name}`));
			}

			const imageInfo = results.images[0];

			let imageName = imageInfo.name;
			const imageDigest = imageInfo.digest;

			if (imageName === null) {
				throw(new Error(`No image name returned while building ${name}`));
			}

			imageName = imageName.split(':')[0];

			return(`${imageName}@${imageDigest}`);
		});

		return(image);
	}

	clean() {
		if (this.localAsset) {
			this.localAsset.clean();
		}
	}

	static childProvider(input: Pick<GCPDockerRemoteImageInput, 'provider'>) {
		/**
		 * If a provider is provided, use it for the child resources
		 */
		let childProvider: gcp.Provider | undefined;
		if (gcp.Provider.isInstance(input.provider)) {
			childProvider = input.provider;
		}

		return(childProvider);
	}

	static bindPermissions(prefix: string, input: Pick<GCPDockerRemoteImageInput, 'bucket' | 'serviceAccount' | 'provider'>, includeProject: boolean = false) {
		const childProvider = this.childProvider(input);

		new gcp.storage.BucketIAMMember(`${prefix}-iam-bucket`, {
			bucket: input.bucket.name,
			member: pulumi.interpolate`serviceAccount:${input.serviceAccount.email}`,
			role: 'roles/storage.objectCreator'
		}, {
			provider: childProvider
		});

		if (includeProject) {
			const projectPerms = {
				'logs': 'roles/logging.logWriter',
				'builds': 'roles/cloudbuild.builds.builder',
				'serviceAgent': 'roles/cloudbuild.serviceAgent'
			};

			const project = input.provider.project.apply(function(checkProject) {
				if (checkProject === undefined || checkProject === null) {
					throw(new Error('No project specified for provider'));
				}

				return(checkProject);
			});

			for (const [name, role] of Object.entries(projectPerms)) {
				new gcp.projects.IAMMember(`${prefix}-iam-${name}`, {
					project: project,
					member: pulumi.interpolate`serviceAccount:${input.serviceAccount.email}`,
					role: role
				}, {
					provider: childProvider
				});
			}
		}
	}
}

type GenericDockerImageInput = (GCPDockerLocalImageInput | GCPDockerRemoteImageInput) & {
	/**
	 * Automatically grant the specified Service Account access to the
	 * bucket to upload the source code for code build
	 */
	bindPermissions?: boolean;
};

/**
 * Create a Docker image using either a local Docker build or GCP CloudBuild
 */
export class DockerImage implements PublicInterface<LocalDockerImage> {
	readonly urn: LocalDockerImage['urn'];
	readonly uri: LocalDockerImage['uri'];
	readonly image: LocalDockerImage['image'];
	readonly imageBase: LocalDockerImage['imageBase'];
	readonly getProvider: LocalDockerImage['getProvider'];
	readonly clean: LocalDockerImage['clean'];

	constructor(prefix: string, input: GenericDockerImageInput, opts?: pulumi.CustomResourceOptions) {
		let image: RemoteDockerImage | LocalDockerImage;

		if ('serviceAccount' in input && 'bucket' in input && 'provider' in input) {
			if (input.bindPermissions === true) {
				RemoteDockerImage.bindPermissions(prefix, input);
			}

			image = new RemoteDockerImage(prefix, input, opts);
		} else {
			image = new LocalDockerImage(prefix, input, opts);
		}

		this.urn = image.urn;
		this.uri = image.uri;
		this.image = image.image;
		this.imageBase = image.imageBase;
		this.getProvider = image.getProvider.bind(image);
		this.clean = image.clean;
	}

	async _checkImage(..._ignore_args: Parameters<LocalDockerImage['_checkImage']>) : Promise<string>;
	async _checkImage(..._ignore_args: Parameters<LocalDockerImage['_checkImage']>): Promise<pulumi.Output<string>>;
	async _checkImage(..._ignore_args: Parameters<LocalDockerImage['_checkImage']>): Promise<string | pulumi.Output<string>> {
		throw(new Error('internal function, do not call'));
	}
}

export default LocalDockerImage;
