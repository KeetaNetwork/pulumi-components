import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisifyExec } from '../utils';
import * as pulumi from '@pulumi/pulumi';
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
	versioning: { type: 'FILE', fromFile: string; } | { type: 'PLAIN', value: string; };
	buildArgs?: { [key: string]: string | undefined };
	buildDirectory: string;
	dockerfile?: string;
	platform?: string;
	additionalArguments?: string[]
}

export class Image extends pulumi.ComponentResource {
	private static AwaitingOutput: { [rawUrl: string]: Promise<pulumi.Output<string>> } = {};

	readonly uri: pulumi.Output<string>;

	private async checkImage(imageURI: string, input: GCPDockerImageInput) {
		try {
			try {
				// Remove the local copy of the image
				await promisifyExec('docker', [ 'rm', imageURI ]);

				// Attempt to pull the remote version of the image
				await promisifyExec('docker', [ 'pull', imageURI ]);
			} catch {
				const args = [ 'build', input.buildDirectory, '-t', imageURI ];

				if (input.dockerfile) {
					args.push('-f', input.dockerfile);
				}

				if (input.platform) {
					args.push('--platform', input.platform);
				}

				for (const [ key, value ] of Object.entries(input.buildArgs ?? {})) {
					args.push('--build-arg', `${key}=${value ?? ''}`);
				}

				await promisifyExec('docker', [...args, ...(input.additionalArguments || [])]);

				await promisifyExec('docker', [ 'image', 'push', imageURI ]);
			}

			return imageURI;
		} catch (e) {
			console.log(`Failed to build docker image ${imageURI}`, e);

			throw e;
		}
	}

	constructor(prefix: string, input: GCPDockerImageInput, opts?: pulumi.CustomResourceOptions) {
		super(`${GCP_COMPONENT_PREFIX}:DockerImage`, prefix, {}, { ...opts });

		let forwardSlash = '';
		if (!input.registryUrl.endsWith('/')) {
			forwardSlash = '/';
		}

		let versionIdentifier;

		if (input.versioning.type === 'FILE') {
			versionIdentifier = getFileResourceIdentifier(input.versioning.fromFile);
		} else if (input.versioning.type === 'PLAIN') {
			versionIdentifier = input.versioning.value;
		} else {
			throw new Error(`Invalid docker versioning input ${JSON.stringify(input.versioning)}`);
		}

		const imageURI = `${input.registryUrl}${forwardSlash}${input.imageName}:${versionIdentifier}`;
		if (Image.AwaitingOutput[imageURI] === undefined) {
			Image.AwaitingOutput[imageURI] = this.checkImage(imageURI, input);
		}

		this.uri = pulumi.output(Image.AwaitingOutput[imageURI]);

		this.registerOutputs({ uri: this.uri });
	}
}

export default Image;
