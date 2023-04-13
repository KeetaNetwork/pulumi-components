import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { promisifyExec, hash } from '../utils';
import type { PublicInterface } from '../utils';
import type { DeepInput } from '../types';
import CloudBuild from './gcp/cloudbuild';
import type { ISecrets } from './gcp/cloudbuild';
import * as Tarball from './tarball';
import { GCP_COMPONENT_PREFIX } from './gcp/constants';
import LocalDockerImageBuilder from './localdocker';
import type { google } from '@google-cloud/cloudbuild/build/protos/protos';

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

	return hashState.digest('hex');
}

interface SecretsInput {
	[envName: string]: pulumi.Input<string>;
}

interface BaseBuildDirectoryOptions<Type extends 'GIT' | 'DIRECTORY'> {
	type: Type;
	directory: string;
	/**
	 * Path to dockerfile to use, relative to root of build directory
	 */
	dockerfilePath?: string;
}

interface GitBuildDirOptions extends BaseBuildDirectoryOptions<'GIT'> {
	commitID?: string;
}

interface DirectoryBuildDirOptions extends BaseBuildDirectoryOptions<'DIRECTORY'> {
	excludePatterns?: string[];
	inputCacheTag?: string;
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
	buildArgs?: { [key: string]: pulumi.Input<string> | undefined };

	/**
	 * Source to build from, either a directory or a git
	 * working copy and optional commit
	 */
	buildDirectory: string | GitBuildDirOptions | DirectoryBuildDirOptions;

	/**
	 * Platform to build image for
	 */
	platform?: string;

	/**
	 * Secrets to set Environment Variables for
	 */
	secrets?: SecretsInput;

	/**
	 * Automatically grant the specified Service Account access to the
	 * bucket to upload the source code for code build
	 */
	bindPermissions?: boolean;
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
	private static AwaitingOutput: { [rawUrl: string]: pulumi.Output<string> } = {};

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

	/**
	 * Cache tag for generated tarball, which may be used for caching
	 * tarball creation from directories
	 */
	readonly inputCacheTag?: string;

	/**
	 * Directories to clean after completion
	 */
	protected toCleanDirectories: string[] = [];

	abstract _checkImage(prefix: string, imageURI: string, input: GCPDockerLocalImageInput | GCPDockerRemoteImageInput): pulumi.Output<string>;

	protected getDockerBuildArgs(input: GCPDockerImageInput, buildDirectory: string) {
		const args: pulumi.Input<string>[] = [];

		if (this.imageCache) {
			args.push('--cache-from', `${this.imageCache}`);
		}

		if (input.platform) {
			args.push('--platform', input.platform);
		}

		for (const [ key, value ] of Object.entries(input.buildArgs ?? {})) {
			args.push('--build-arg', pulumi.interpolate`${key}=${value ?? ''}`);
		}

		if (typeof input.buildDirectory !== 'string' && input.buildDirectory.dockerfilePath) {
			args.push('-f', path.join(buildDirectory, input.buildDirectory.dockerfilePath));
		}

		const retval = pulumi.all(args);

		return(retval);
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

	protected resolveSecretsObject(secrets: SecretsInput) {
		return pulumi.secret(secrets).apply(function(unwrapped) {
			return Object.entries(unwrapped).map(function([key, value]) {
				return(`${key}=${value}`);
			}).join('\n');
		});
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
			const imageInfo = pulumi.output(this._checkImage(prefix, imageURI, input));

			BaseDockerImage.AwaitingOutput[imageURI] = imageInfo;
		}

		this.uri = BaseDockerImage.AwaitingOutput[imageURI];

		this.registerOutputs({ uri: this.uri });
	}

	/**
	 * Perform any cleanup required post-deployment
	 */
	clean() {
		if (this.toCleanDirectories === undefined) {
			return;
		}

		for (const cleanDir of this.toCleanDirectories) {
			fs.rmSync(cleanDir, { recursive: true, force: true });
		}
	}
}

export class LocalDockerImage extends BaseDockerImage {
	private async getBuildDirectory(input: GCPDockerImageInput['buildDirectory'], cacheID: string) {
		if (typeof input === 'string') {
			return input;
		}

		let tarball;
		if (input.type === 'GIT') {
			tarball = new Tarball.GitTarballArchive(input.directory, input.commitID);
		} else if (input.type === 'DIRECTORY') {
			tarball = new Tarball.DirTarballArchive(input.directory, cacheID, input.excludePatterns);
		} else {
			throw new Error(`Invalid docker buildDirectory input ${JSON.stringify(input)}`);
		}

		const tarballPath = await tarball.path;

		const tmpDir = fs.mkdtempSync('/tmp/docker-build-');
		this.toCleanDirectories.push(tmpDir);

		try {
			await promisifyExec('tar', [ '-zxf', tarballPath, '-C', tmpDir ]);
		} catch {
			throw new Error(`Failed to extract tarball ${tarballPath} to ${tmpDir}`);
		}

		return(tmpDir);
	}

	_checkImage(prefix: string, imageURI: string, input: GCPDockerImageInput): pulumi.Output<string> {
		/**
		 * Cache ID based on the ImageURI, which includes the version
		 * info so if it changes the image will be rebuilt
		 */
		const cacheID = this.inputCacheTag ?? hash(imageURI, 32);

		let secretContents;
		if (input.secrets) {
			secretContents = this.resolveSecretsObject(input.secrets);
		}

		const buildDirectory = pulumi.output(this.getBuildDirectory(input.buildDirectory, cacheID));

		const buildArgs = buildDirectory.apply((directory) => {
			return this.getDockerBuildArgs(input, directory);
		});

		const image = new LocalDockerImageBuilder(`${prefix}-docker-builder`, {
			imageURI: imageURI,
			buildDirectory: buildDirectory,
			secretContents: secretContents,
			buildArgs: buildArgs,
			imageCache: this.imageCache,
			tags: this.getDockerBuildTags(input),
			cleanBuildDirectory: false
		});

		return image.digest;
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
	private getBuildTarball(input: GCPDockerImageInput['buildDirectory'], cacheID: string) {
		let tarball: Tarball.GitTarballArchive | Tarball.DirTarballArchive;
		if (typeof input === 'string') {
			tarball = new Tarball.DirTarballArchive(input, cacheID);
		} else if (input.type === 'DIRECTORY') {
			tarball = new Tarball.DirTarballArchive(input.directory, cacheID, input.excludePatterns);
		} else if (input.type === 'GIT') {
			tarball = new Tarball.GitTarballArchive(input.directory, input.commitID);
		} else {
			throw new Error(`Unknown buildDirectory input: ${JSON.stringify(input)}`);
		}

		this.localAsset = tarball;

		return(tarball);

	}

	_checkImage(prefix: string, imageURI: string, input: GCPDockerRemoteImageInput): pulumi.Output<string> {
		/**
		 * Cache ID based on the ImageURI, which includes the version
		 * info so if it changes the image will be rebuilt
		 */
		const cacheID = this.inputCacheTag ?? hash(imageURI, 32);

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
		const source = this.getBuildTarball(input.buildDirectory, cacheID);

		const imageSourceObject = new gcp.storage.BucketObject(`${prefix}-cloudbuild-src`, {
			bucket: input.bucket.name,
			source: source
		}, {
			/*
			 * We keep a copy of the source in the bucket so that we can
			 * access it if needed, since the build output is also kept
			 */
			retainOnDelete: true,
			parent: this
		});

		let imageDependsOn: pulumi.Resource[] = [];

		if (input.bindPermissions) {
			imageDependsOn = this.bindPermissions(prefix, input, true);
		}

		/**
		 * Steps to perform to build the image
		 */
		const steps: DeepInput<google.devtools.cloudbuild.v1.IBuildStep>[] = [];

		let env: string[] | undefined;
		let secretEnv: string[] | undefined;
		const additionalSecretBuildArgs: string[] = [];
		let temporarySecret;
		let availableSecrets: DeepInput<ISecrets> | undefined;

		if (input.secrets) {
			const remoteSecretFileDirectory = '/workspace/secrets';
			const remoteSecretFilePath = path.join(remoteSecretFileDirectory, './keeta-build-secrets.txt');

			/**
			 * Serialized form of secrets
			 */
			const secrets = this.resolveSecretsObject(input.secrets);

			/**
			 * An ID to pass to the build, which will be used to create
			 * a temporary secret in Secret Manager
			 */
			const secretId = secrets.apply(function(secretsPlain) {
				const hashParts = [
					prefix,
					secretsPlain,
					cacheID
				];

				return(`temporary-delete-me-build-secret-${hash(hashParts.join('|'), 8)}`);
			});

			/**
			 * Structure to pass to the build, which will be used to create
			 * a temporary secret in Secret Manager
			 */
			temporarySecret = {
				secretId: secretId,
				input: secrets
			};

			const secretEnvName = 'KEETA_SECRET';

			env = [ 'DOCKER_BUILDKIT=1' ];
			secretEnv = [ secretEnvName ];
			additionalSecretBuildArgs.push('--secret', `id=secrets,src=${remoteSecretFilePath}`);

			steps.push({
				id: 'create-secret-file',
				name: 'gcr.io/cloud-builders/gcloud',
				entrypoint: 'bash',
				args: [
					'-c', `mkdir -p ${remoteSecretFileDirectory} && echo $$${secretEnvName} > ${remoteSecretFilePath}`
				],
				secretEnv: [secretEnvName]
			});

			availableSecrets = {
				secretManager: [{
					versionName: pulumi.interpolate`projects/${input.provider.project}/secrets/${secretId}/versions/latest`,
					env: secretEnvName
				}]
			};
		}

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
			id: 'build-image',
			name: 'gcr.io/cloud-builders/docker',
			args: this.getDockerBuildArgs(input, '.').apply((buildArgs) => {
				return([
					'build',
					'-t',
					this.image,
					...additionalSecretBuildArgs,
					...buildArgs,
					'.'
				]);
			}),
			env: env,
			secretEnv: secretEnv
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
			temporarySecret: temporarySecret,
			build: {
				serviceAccount: pulumi.interpolate`projects/${project}/serviceAccounts/${serviceAccount.email}`,
				availableSecrets: availableSecrets,
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
		}, { parent: this, dependsOn: imageDependsOn });

		// Clean after cloudBuild has completed
		buildInfo.results.apply(this.clean.bind(this));

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
		super.clean();

		if (this.localAsset) {
			this.localAsset.clean();
		}
	}

	bindPermissions(prefix: string, input: Pick<GCPDockerRemoteImageInput, 'bucket' | 'serviceAccount' | 'provider'>, includeProject: boolean = false): pulumi.Resource[] {
		const createdBindings = [];

		const iamMemberBinding = new gcp.storage.BucketIAMMember(`${prefix}-iam-bucket`, {
			bucket: input.bucket.name,
			member: pulumi.interpolate`serviceAccount:${input.serviceAccount.email}`,
			role: 'roles/storage.objectCreator'
		}, { parent: this });

		createdBindings.push(iamMemberBinding);

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
				const singleIamBinding = new gcp.projects.IAMMember(`${prefix}-iam-${name}`, {
					project: project,
					member: pulumi.interpolate`serviceAccount:${input.serviceAccount.email}`,
					role: role
				}, { parent: this });

				createdBindings.push(singleIamBinding);
			}
		}

		return createdBindings;
	}
}

type GenericDockerImageInput = GCPDockerLocalImageInput | GCPDockerRemoteImageInput;
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

	_checkImage(..._ignore_args: Parameters<LocalDockerImage['_checkImage']>): pulumi.Output<string> {
		throw(new Error('internal function, do not call'));
	}
}

export default LocalDockerImage;
