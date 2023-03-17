import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisifyExec } from '../utils';
import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { GCP_COMPONENT_PREFIX } from './gcp/constants';
import { CloudBuild, HashType } from './gcp/cloudbuild';
import { GcpRegionName } from './gcp/regions';

function updateHashWithSingleFile(fullPath: string, hash: crypto.Hash) {
	hash.update(fs.readFileSync(fullPath));
}

function updateHashWithMultipleFiles(filePath: string, hash: crypto.Hash) {
	if (fs.statSync(filePath).isFile()) {
		updateHashWithSingleFile(filePath, hash);
		return;
	}

	const info = fs.readdirSync(filePath, { withFileTypes: true });

	for (const item of info) {
		const fullPath = path.join(filePath, item.name);
		if (item.isFile()) {
			updateHashWithSingleFile(fullPath, hash);
			continue;
		}

		if (item.isDirectory()) {
			updateHashWithMultipleFiles(fullPath, hash);
		}
	}
}

export function getFileResourceIdentifier(computeFrom: string): string {
	const hash = crypto.createHash('sha1');

	updateHashWithMultipleFiles(computeFrom, hash);

	return hash.digest('hex').substring(0, 9);
}

interface DockerImageTargetBase {
	type: 'LOCAL' | 'CLOUD_BUILD';
}

interface CanCreate<T extends boolean> { create: T }

export interface ServiceAccountInputCreate extends CanCreate<true> {
	addLogWriterIAM?: boolean;
}

export interface ServiceAccountInputManual extends CanCreate<false> {
	serviceAccountEmail: pulumi.Input<string>;
}

interface AssetInputBase {
	type: 'UPLOAD' | 'MANUAL';
}

export interface BucketLike {
	id: pulumi.Input<string>;
	name: pulumi.Input<string>;
}

export interface AssetInputManual extends AssetInputBase {
	type: 'MANUAL';
	bucket: BucketLike;
	fileName: pulumi.Input<string>;
}

interface BucketInputCreate extends CanCreate<true> {
	region: GcpRegionName;
}

interface BucketInputManual extends CanCreate<false> {
	bucket: BucketLike;
}

export interface BucketInputUploadOrCreate extends AssetInputBase {
	type: 'UPLOAD';
	bucketConfig: BucketInputManual | BucketInputCreate;
	tarball: pulumi.asset.FileAsset;
}

export interface DockerImageInputTargetCloudBuild extends DockerImageTargetBase {
	type: 'CLOUD_BUILD';
	projectId: pulumi.Input<string>;
	serviceAccount: ServiceAccountInputCreate | ServiceAccountInputManual;
	asset: BucketInputUploadOrCreate | AssetInputManual;
}

export interface DockerImageInputLocal extends DockerImageTargetBase {
	type: 'LOCAL';
	direcrory: string;
}


export interface DockerImageInput {
	imageName: string;
	registryUrl: string;
	target: DockerImageInputLocal | DockerImageInputTargetCloudBuild;
	identifier: { type: 'FILE', fromFile: string; } | { type: 'PLAIN', value: string; };
	buildArgs?: { [key: string]: string | undefined };
	dockerfilePath?: string;
	platform?: string;
	additionalArguments?: string[];
}

export class Image extends pulumi.ComponentResource {
	private static AwaitingOutput: { [rawUrl: string]: Promise<pulumi.Output<string> | string> } = {};

	#prefix: string;

	readonly uri: pulumi.Output<string>;

	#baseImageURI: string;
	#imageIdentifier: string;

	get #identifierURI() {
		return(`${this.#baseImageURI}:${this.#imageIdentifier}`);
	}

	computeDockerFlags(input: DockerImageInput) {
		const args = [];

		if (input.dockerfilePath) {
			args.push('-f', input.dockerfilePath);
		}

		if (input.platform) {
			args.push('--platform', input.platform);
		}

		for (const [ key, value ] of Object.entries(input.buildArgs ?? {})) {
			args.push('--build-arg', `${key}=${value ?? ''}`);
		}

		if (input.additionalArguments) {
			args.push(...input.additionalArguments);
		}

		return args;
	}

	private async generateWithLocalDocker(input: DockerImageInput) {
		if (input.target.type !== 'LOCAL') {
			throw new Error('Type must be local when calling generateWithLocalDocker()');
		}

		const imageURI = this.#identifierURI;

		try {
			try {
				// Remove the local copy of the image
				await promisifyExec('docker', [ 'rm', imageURI ]);

				// Attempt to pull the remote version of the image
				await promisifyExec('docker', [ 'pull', imageURI ]);
			} catch {
				await promisifyExec('docker', ['build', input.target.direcrory, '-t', imageURI, ...this.computeDockerFlags(input)]);

				await promisifyExec('docker', [ 'image', 'push', imageURI ]);
			}

			return imageURI;
		} catch (e) {
			console.log(`Failed to build docker image ${imageURI}`);

			throw e;
		}
	}

	// XXX:Todo, support cloud build secrets
	private async generateWithCloudBuild(input: DockerImageInput) {
		const latestURI = `${this.#baseImageURI}:latest`;
		const identifierURI = this.#identifierURI;

		if (input.target?.type !== 'CLOUD_BUILD') {
			throw new Error('Cannot call generateWithCloudBuild() when target.type is not CLOUD_BUILD');
		}

		const { projectId } = input.target;

		let serviceAccountEmail: pulumi.Input<string>;
		if (input.target.serviceAccount.create) {
			if (input.target.asset.type === 'MANUAL') {
				throw new Error('There is no reason to create a service account when target input is MANUAL');
			}

			const serviceAccountName = `${this.#prefix}-sa`;
			const serviceAccount = new gcp.serviceaccount.Account(serviceAccountName, {
				accountId: serviceAccountName,
				displayName: `Service Account for ${this.#prefix} Docker`
			}, { parent: this, deleteBeforeReplace: true });

			if (input.target.serviceAccount.addLogWriterIAM !== false) {
				new gcp.projects.IAMMember(`${serviceAccountName}-write-logs`, {
					project: input.target.projectId,
					role: 'roles/logging.logWriter',
					member: pulumi.interpolate`serviceAccount:${serviceAccount.email}`
				}, { parent: serviceAccount });
			}

			serviceAccountEmail = serviceAccount.email;
		} else {
			serviceAccountEmail = input.target.serviceAccount.serviceAccountEmail;
		}

		let bucketName;
		let bucketFileName;
		if (input.target.asset.type === 'MANUAL') {
			bucketName = input.target.asset.bucket.name;
			bucketFileName = input.target.asset.fileName;
		} else {
			const bucketConfig = input.target.asset.bucketConfig;

			let bucketId;

			if (bucketConfig.create) {
				const bucket = new gcp.storage.Bucket(`${this.#prefix}-bucket`, {
					location: bucketConfig.region
				}, { parent: this });

				bucketId = bucket.id;
				bucketName = bucket.name;

				// XXX:TODO Grant service account access to read repo
				new gcp.storage.BucketIAMMember(`${this.#prefix}-allow-sa-read`, {
					bucket: bucket.id,
					member: pulumi.interpolate`serviceAccount:${serviceAccountEmail}`,
					role: 'roles/storage.admin'
				}, { parent: bucket });
			} else {
				bucketId = bucketConfig.bucket.id;
				bucketName = bucketConfig.bucket.name;
			}

			const toBuild = new gcp.storage.BucketObject(`${this.#prefix}-asset`, {
				name: `jester-${this.#prefix}.tar.gz`,
				bucket: bucketId,
				source: input.target.asset.tarball
			}, { parent: this });

			bucketFileName = toBuild.name;
		}

		const cloudbuild = new CloudBuild(`${this.#prefix}-cloudbuild`, {
			projectId: projectId,
			build: {
				serviceAccount: pulumi.interpolate`projects/${projectId}/serviceAccounts/${serviceAccountEmail}`,
				images: [ identifierURI, latestURI ],
				timeout: {
					seconds: 8/* h */ * 60/* m */ * 60/* s */
				},
				steps: [{
					name: 'gcr.io/cloud-builders/docker',
					args: [ 'pull', latestURI ],
					allowFailure: true
				}, {
					name: 'gcr.io/cloud-builders/docker',
					args: [ 'build', '-t', identifierURI, '--cache-from', latestURI, '.', ...this.computeDockerFlags(input) ]
				}, {
					name: 'gcr.io/cloud-builders/docker',
					args: [ 'tag', identifierURI, latestURI ]
				}],
				options: {
					logging: 'CLOUD_LOGGING_ONLY',
					machineType: 'E2_HIGHCPU_8',
					requestedVerifyOption: 'VERIFIED',
					sourceProvenanceHash: [ HashType.SHA256 ]
				},
				source: {
					storageSource: {
						bucket: bucketName,
						object: bucketFileName
					}
				}
			}
		}, { parent: this });

		const imageURIWithDigest = cloudbuild.results.apply((results) => {
			if (results === undefined || results === null) {
				throw(new Error(`No results from build process for ${this.#prefix}`));
			}

			if (!Array.isArray(results.images) || results.images.length === 0) {
				throw(new Error(`No images built while building ${this.#prefix}`));
			}

			const { name, digest } = results.images[0];

			if (!name || !digest) {
				throw(new Error(`No image name/digest returned while building ${this.#prefix}`));
			}

			return(`${name.split(':')[0]}@${digest}`);
		});

		return imageURIWithDigest;
	}

	constructor(prefix: string, input: DockerImageInput, opts?: pulumi.CustomResourceOptions) {
		super(`${GCP_COMPONENT_PREFIX}:DockerImage`, prefix, {}, { ...opts });
		this.#prefix = prefix;

		let buildIdentifier;
		if (input.identifier.type === 'FILE') {
			buildIdentifier = getFileResourceIdentifier(input.identifier.fromFile);
		} else if (input.identifier.type === 'PLAIN') {
			buildIdentifier = input.identifier.value;
		} else {
			throw new Error(`Invalid docker versioning input ${JSON.stringify(input.identifier)}`);
		}

		let forwardSlash = '';
		if (!input.registryUrl.endsWith('/')) {
			forwardSlash = '/';
		}

		const targetType = input.target?.type ?? 'LOCAL';

		this.#baseImageURI = `${input.registryUrl}${forwardSlash}${input.imageName}`;
		this.#imageIdentifier = buildIdentifier;

		const buildID = `${this.#baseImageURI}-${targetType}`;

		if (Image.AwaitingOutput[buildID] === undefined) {
			switch (targetType) {
				case 'LOCAL':
					Image.AwaitingOutput[buildID] = this.generateWithLocalDocker(input);
					break;
				case 'CLOUD_BUILD':
					Image.AwaitingOutput[buildID] = this.generateWithCloudBuild(input);
					break;
			}
		}

		this.uri = pulumi.output(Image.AwaitingOutput[buildID]);

		this.registerOutputs({ uri: this.uri });
	}
}

export default Image;
