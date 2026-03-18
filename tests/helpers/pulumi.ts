import * as automation from '@pulumi/pulumi/automation';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export interface StackOutputs {
	[key: string]: unknown;
}

/**
 * Deploy a Pulumi stack from a project directory
 * @param projectDir - Path to the Pulumi project directory (relative to repo root)
 * @param stackName - Name for the stack
 * @param extraConfig - Additional config values to set before deployment
 * @returns Stack outputs after successful deployment
 */
export async function deployStack(
	projectDir: string,
	stackName: string,
	extraConfig?: { [key: string]: string }
): Promise<StackOutputs> {
	const workDir = path.resolve(process.cwd(), projectDir);

	// Install dependencies in the project directory
	console.log(`Installing dependencies in ${workDir}...`);
	execSync('npm install', { cwd: workDir, stdio: 'inherit' });

	const stack = await automation.LocalWorkspace.createOrSelectStack(
		{ stackName, workDir },
		{ secretsProvider: 'gcpkms://projects/mimetic-algebra-344104/locations/nam8/keyRings/pulumi-secrets/cryptoKeys/dev' }
	);

	// Set required config
	await stack.setConfig('gcp:project', {
		value: process.env.GOOGLE_PROJECT ?? process.env.GCLOUD_PROJECT ?? ''
	});

	if (extraConfig) {
		for (const [key, value] of Object.entries(extraConfig)) {
			await stack.setConfig(key, { value });
		}
	}

	// Run pulumi up
	const upResult = await stack.up({
		onOutput: function(msg) {
			process.stdout.write(msg);
		}
	});

	if (upResult.summary.result !== 'succeeded') {
		throw(new Error(`Deployment failed with status '${upResult.summary.result}': ${upResult.summary.message}`));
	}

	// Get outputs
	const outputs = await stack.outputs();
	const result: StackOutputs = {};

	for (const [key, output] of Object.entries(outputs)) {
		result[key] = output.value;
	}

	return(result);
}

/**
 * Destroy a Pulumi stack and remove it
 * @param projectDir - Path to the Pulumi project directory (relative to repo root)
 * @param stackName - Name of the stack to destroy
 */
export async function destroyStack(projectDir: string, stackName: string): Promise<void> {
	const workDir = path.resolve(process.cwd(), projectDir);

	try {
		const stack = await automation.LocalWorkspace.selectStack({
			stackName,
			workDir
		});

		// Destroy all resources
		await stack.destroy({
			onOutput: function(msg) {
				process.stdout.write(msg);
			}
		});

		// Remove the stack
		await stack.workspace.removeStack(stackName);
	} catch (err) {
		// Log but don't fail if stack doesn't exist
		console.error(`Warning: Failed to destroy stack ${stackName}:`, err);
	}
}

/**
 * Retry a fetch request until it succeeds or max attempts are exhausted.
 * Useful for resources like load balancers that need propagation time.
 *
 * @param url - URL to fetch
 * @param options - Fetch options
 * @param maxAttempts - Maximum retry attempts (default 10)
 * @param delayMs - Delay between retries in ms (default 60000)
 */
export async function fetchWithRetry(
	url: string,
	options?: RequestInit,
	maxAttempts = 10,
	delayMs = 60_000
): Promise<Response> {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fetch(url, options);
		} catch (err) {
			if (attempt === maxAttempts) {
				throw err;
			}

			await new Promise(function(resolve) { setTimeout(resolve, delayMs); });
		}
	}

	throw new Error('Unreachable');
}

/**
 * Refresh a Pulumi stack to sync state with cloud provider
 * @param projectDir - Path to the Pulumi project directory
 * @param stackName - Name of the stack
 */
export async function refreshStack(projectDir: string, stackName: string): Promise<void> {
	const workDir = path.resolve(process.cwd(), projectDir);

	const stack = await automation.LocalWorkspace.selectStack({
		stackName,
		workDir
	});

	await stack.refresh({
		onOutput: function(msg) {
			process.stdout.write(msg);
		}
	});
}
