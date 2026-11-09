/*
 * The full path, because the cleanup script loads this file as an ES module
 * under Node, and "@pulumi/pulumi" has no "exports" map to resolve the
 * directory
 */
import * as automation from '@pulumi/pulumi/automation/index.js';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export interface StackOutputs {
	[key: string]: unknown;
}

const SECRETS_PROVIDER = 'gcpkms://projects/mimetic-algebra-344104/locations/nam8/keyRings/pulumi-secrets/cryptoKeys/dev';

/**
 * The GitHub Actions run this process belongs to, or undefined outside one
 */
export function currentRunId(): string | undefined {
	const runId = process.env.GITHUB_RUN_ID;
	if (runId === undefined || runId === '') {
		return(undefined);
	}

	return(runId);
}

/**
 * Prefix shared by every stack this test run creates: `ci-<GITHUB_RUN_ID>-`,
 * or `ci-local-` outside GitHub Actions
 */
export function runStackPrefix(runId = currentRunId()): string {
	return(`ci-${runId ?? 'local'}-`);
}

/**
 * Name for a new test stack: `ci-<GITHUB_RUN_ID or local>-<suffix>-<Date.now()>`.
 * The trailing timestamp is when the stack was created; the cleanup reads it.
 * @param suffix - Short label of the test that owns the stack
 */
export function testStackName(suffix: string): string {
	return(`${runStackPrefix()}${suffix}-${Date.now()}`);
}

/**
 * Prefixes of every stack name the integration tests create, today's and
 * earlier ones ("test-<Date.now()>")
 */
const TEST_STACK_PREFIXES = ['ci-', 'test-'];

export interface StackToClean {
	name: string;
	reason: string;
}

/**
 * Pick the test stacks to destroy: every stack of the given run, and every
 * other test stack not touched for longer than maxAgeMs. The age is measured
 * from the later of the stack's last update and the creation time in its
 * name, so a stack whose first update never finished still ages out.
 * @param stacks - Stacks of one Pulumi project
 * @param options.runId - The run whose stacks are always destroyed, if any
 * @param options.maxAgeMs - Age after which another test stack is stale
 * @param options.now - The current time
 */
export function selectStacksToClean(
	stacks: readonly automation.StackSummary[],
	options: { runId: string | undefined; maxAgeMs: number; now: number }
): StackToClean[] {
	const selected: StackToClean[] = [];

	for (const summary of stacks) {
		const name = summary.name;

		if (options.runId !== undefined && name.startsWith(runStackPrefix(options.runId))) {
			selected.push({ name, reason: `belongs to run ${options.runId}` });
			continue;
		}

		if (!TEST_STACK_PREFIXES.some(function(prefix) { return(name.startsWith(prefix)); })) {
			continue;
		}

		const lastUpdate = summary.lastUpdate === undefined ? NaN : Date.parse(summary.lastUpdate);
		const createdMatch = /-(\d{13})$/.exec(name);
		const createdAt = createdMatch === null ? NaN : Number(createdMatch[1]);
		const touchedAt = Math.max(...[lastUpdate, createdAt].filter(Number.isFinite));
		if (!Number.isFinite(touchedAt)) {
			console.warn(`Skipping stack ${name}: neither its last update nor its name gives its age`);
			continue;
		}

		const ageMs = options.now - touchedAt;
		if (ageMs > options.maxAgeMs) {
			selected.push({ name, reason: `stale: last touched ${Math.round(ageMs / 60_000)} minutes ago` });
		}
	}

	return(selected);
}

function onOutput(msg: string): void {
	process.stdout.write(msg);
}

/**
 * Install a project's dependencies: running the program, and `destroy`'s
 * plugin discovery, both read the project's "node_modules"
 * @param workDir - Absolute path of the Pulumi project directory
 */
export function installProjectDependencies(workDir: string): void {
	console.log(`Installing dependencies in ${workDir}...`);
	execSync('npm install', { cwd: workDir, stdio: 'inherit' });
}

/**
 * Apply the config every test stack needs. "destroy" needs it too: the
 * default GCP provider reads "gcp:project" from the stack config.
 */
async function setRequiredConfig(stack: automation.Stack): Promise<void> {
	await stack.setConfig('gcp:project', {
		value: process.env.GOOGLE_PROJECT ?? process.env.GCLOUD_PROJECT ?? ''
	});
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

	installProjectDependencies(workDir);

	const stack = await automation.LocalWorkspace.createOrSelectStack(
		{ stackName, workDir },
		{ secretsProvider: SECRETS_PROVIDER }
	);

	await setRequiredConfig(stack);

	if (extraConfig) {
		for (const [key, value] of Object.entries(extraConfig)) {
			await stack.setConfig(key, { value });
		}
	}

	// Run pulumi up
	const upResult = await stack.up({ onOutput });

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

async function destroyOnce(stack: automation.Stack): Promise<void> {
	const result = await stack.destroy({ onOutput });

	if (result.summary.result !== 'succeeded') {
		throw(new Error(`Destroy of stack ${stack.name} ended with status '${result.summary.result}': ${result.summary.message}`));
	}
}

/**
 * Destroy a Pulumi stack and remove it. A stack that does not exist is
 * already clean. Any other failure is retried once after a refresh, and then
 * thrown, so a teardown that leaves cloud resources behind fails the run.
 * @param projectDir - Path to the Pulumi project directory (relative to repo root)
 * @param stackName - Name of the stack to destroy
 */
export async function destroyStack(projectDir: string, stackName: string): Promise<void> {
	const workDir = path.resolve(process.cwd(), projectDir);

	let stack: automation.Stack;
	try {
		stack = await automation.LocalWorkspace.selectStack({ stackName, workDir });
	} catch (err) {
		if (err instanceof automation.StackNotFoundError) {
			console.log(`Stack ${stackName} does not exist in ${projectDir}; nothing to destroy`);

			return;
		}

		throw(err);
	}

	await setRequiredConfig(stack);

	try {
		await destroyOnce(stack);
	} catch (firstErr) {
		console.error(`Destroy of stack ${stackName} failed; refreshing and retrying once:`, firstErr);

		try {
			await stack.refresh({ onOutput });
			await destroyOnce(stack);
		} catch (retryErr) {
			throw(new Error(`Destroy of stack ${stackName} in ${projectDir} failed twice; its resources are still deployed`, { cause: retryErr }));
		}
	}

	await stack.workspace.removeStack(stackName);
}

/**
 * Retry a fetch request until it succeeds or max attempts are exhausted.
 * Useful for resources like load balancers that need propagation time.
 * Retries on both network errors and responses that fail the validate check.
 *
 * @param url - URL to fetch
 * @param options - Fetch options
 * @param validate - Optional function to validate the response; return false to retry
 * @param maxAttempts - Maximum retry attempts (default 10)
 * @param delayMs - Delay between retries in ms (default 60000)
 */
export async function fetchWithRetry(
	url: string,
	options?: RequestInit,
	validate?: (response: Response) => boolean,
	maxAttempts = 10,
	delayMs = 60_000
): Promise<Response> {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const response = await fetch(url, options);

			if (!validate || validate(response)) {
				return(response);
			}

			if (attempt === maxAttempts) {
				return(response);
			}
		} catch (err) {
			if (attempt === maxAttempts) {
				throw(err);
			}
		}

		await new Promise(function(resolve) { setTimeout(resolve, delayMs); });
	}

	throw(new Error('Unreachable'));
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

	await stack.refresh({ onOutput });
}

/**
 * Preview a Pulumi stack and return the planned operation for each resource
 * @param projectDir - Path to the Pulumi project directory
 * @param stackName - Name of the stack
 * @returns Map of resource URN to planned operation (e.g., "same", "update")
 */
export async function previewStack(projectDir: string, stackName: string): Promise<{ [urn: string]: string }> {
	const workDir = path.resolve(process.cwd(), projectDir);

	const stack = await automation.LocalWorkspace.selectStack({
		stackName,
		workDir
	});

	const operations: { [urn: string]: string } = {};
	await stack.preview({
		onOutput,
		onEvent: function(event) {
			const metadata = event.resourcePreEvent?.metadata;
			if (metadata) {
				operations[metadata.urn] = metadata.op;
			}
		}
	});

	return(operations);
}
