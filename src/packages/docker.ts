import crypto from 'crypto';
import fs from 'fs';
import type { OutputWrapped } from '../types';
import { promisifyExec } from '../utils';
import * as pulumi from '@pulumi/pulumi';
import { GCP_COMPONENT_PREFIX } from './gcp/constants';

function getFileResourceIdentifier(path: string): string {
	const hash = crypto.createHash('sha1');

	const fileContents = fs.readFileSync(path);
	hash.update(fileContents);

	return hash.digest('hex').substring(0, 9);
}

interface GCPDockerImageInput {
	imageName: string;
	registry_url: string;
	resource_path: string;
	build_args: { [key: string]: string };
	buildDirectory: string;
	dockerfile: string;
	platform?: string;
}

export class Image extends pulumi.ComponentResource {
	private static AwaitingOutput: { [rawUrl: string]: Promise<OutputWrapped<string>> } = {};

	readonly uri: OutputWrapped<string>;

	private async checkImage(imageURI: string, input: GCPDockerImageInput) {
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

			for (const [ key, value ] of Object.entries(input.build_args)) {
				args.push('--build-arg', `${key}=${value}`);
			}

			await promisifyExec('docker', args);

			await promisifyExec('docker', [ 'image', 'push', imageURI ]);
		}

		return imageURI;
	}

	constructor(prefix: string, input: GCPDockerImageInput, opts?: pulumi.CustomResourceOptions) {
		super(`${GCP_COMPONENT_PREFIX}:DockerImage`, prefix, {}, { ...opts });

		const versionIdentifier = getFileResourceIdentifier(input.resource_path);

		let forwardSlash = '';
		if (!input.registry_url.endsWith('/')) {
			forwardSlash = '/';
		}

		const imageURI = `${input.registry_url}${forwardSlash}${input.imageName}:${versionIdentifier}`;
		if (Image.AwaitingOutput[imageURI] === undefined) {
			Image.AwaitingOutput[imageURI] = this.checkImage(imageURI, input);
		}

		this.uri = pulumi.output(Image.AwaitingOutput[imageURI]);

		this.registerOutputs({ uri: this.uri });
	}
}

export default Image;
