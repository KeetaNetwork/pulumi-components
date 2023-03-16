import * as pulumi from '@pulumi/pulumi';

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn as childProcessSpawn } from 'child_process';

import { promisifyExec, PublicInterface } from '../utils';
import CloudBuild from './gcp/cloudbuild';
import * as Tarball from './tarball';
import { GCP_COMPONENT_PREFIX } from './gcp/constants';

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

interface GCPDockerImageInput {
	imageName: string;
	registryUrl: string;
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
	buildArgs?: { [key: string]: string | undefined };
	buildDirectory: string | {
		type: 'GIT';
		directory: string;
		commitID?: string;
	};
	platform?: string;
}

abstract class DockerImage extends pulumi.ComponentResource {
	private static AwaitingOutput: { [rawUrl: string]: Promise<string> } = {};

	readonly uri: pulumi.Output<string>;

	abstract _checkImage(imageURI: string, input: GCPDockerImageInput): Promise<string>;

	constructor(prefix: string, input: GCPDockerImageInput, opts?: pulumi.CustomResourceOptions) {
		super(`${GCP_COMPONENT_PREFIX}:DockerImage`, prefix, {}, { ...opts });

		let forwardSlash = '';
		if (!input.registryUrl.endsWith('/')) {
			forwardSlash = '/';
		}

		let versionIdentifier: string;
		let tarball: Tarball.GitTarballArchive | undefined;

		switch (input.versioning.type) {
			case 'FILE':
				versionIdentifier = getFileResourceIdentifier(input.versioning.fromFile);
				break;
			case 'PLAIN':
				versionIdentifier = input.versioning.value;
				break;
			case 'GIT':
				tarball = new Tarball.GitTarballArchive(input.versioning.directory, input.versioning.commitID);
				versionIdentifier = tarball.uniqueID;
				break;
			default:
				throw new Error(`Invalid docker versioning input ${JSON.stringify(input.versioning)}`);
		}

		const imageURI = `${input.registryUrl}${forwardSlash}${input.imageName}:${versionIdentifier}`;
		if (LocalDockerImage.AwaitingOutput[imageURI] === undefined) {
			LocalDockerImage.AwaitingOutput[imageURI] = this._checkImage(imageURI, input);
		}

		this.uri = pulumi.output(LocalDockerImage.AwaitingOutput[imageURI]);

		this.registerOutputs({ uri: this.uri });
	}
}

export class LocalDockerImage extends DockerImage {
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

	async _checkImage(imageURI: string, input: GCPDockerImageInput): Promise<string> {
		try {
			try {
				// Remove the local copy of the image
				await promisifyExec('docker', [ 'image', 'rm', imageURI ]);
			} catch {
				/* Ignore errors removing an image */
			}

			try {
				// Attempt to pull the remote version of the image
				await promisifyExec('docker', [ 'pull', imageURI ]);
			} catch {
				const buildDirectory = await this.getBuildDirectory(input.buildDirectory);

				/* If we can't pull the image, then build it */
				const args = [ 'build', buildDirectory, '-t', imageURI ];

				if (input.platform) {
					args.push('--platform', input.platform);
				}

				for (const [ key, value ] of Object.entries(input.buildArgs ?? {})) {
					args.push('--build-arg', `${key}=${value ?? ''}`);
				}

				await promisifyExec('docker', args);

				await promisifyExec('docker', [ 'image', 'push', imageURI ]);
			}

			return imageURI;
		} catch (e) {
			console.log(`Failed to build docker image ${imageURI}`, e);

			throw e;
		} finally {
			if (this.cleanTmpDir) {
				fs.rmSync(this.cleanTmpDir, { recursive: true, force: true });
				this.cleanTmpDir = undefined;
			}
		}
	}

	constructor(prefix: string, input: GCPDockerImageInput, opts?: pulumi.CustomResourceOptions) {
		super(prefix, input, opts);
	}
}

export class RemoteDockerImage extends DockerImage implements PublicInterface<LocalDockerImage> {
	private localAsset?: ReturnType<this['getBuildTarball']>;
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
	async _checkImage(imageURI: string, input: GCPDockerImageInput): Promise<string> {
		new CloudBuild(`build-${this.name}`, {
			build: {
				steps: [
					{
						name: 'gcr.io/cloud-builders/docker',
						args: [ 'pull', imageURI ],
					},
				],
			},
		}, { parent: this });
	}

	constructor(prefix: string, input: GCPDockerImageInput, opts?: pulumi.CustomResourceOptions) {
		super(prefix, input, opts);
	}
}

export default LocalDockerImage;
