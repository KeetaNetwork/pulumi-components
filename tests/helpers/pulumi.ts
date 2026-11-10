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
	/** True for a stack of the current run, false for a stale one */
	ownedByRun: boolean;
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
			selected.push({ name, reason: `belongs to run ${options.runId}`, ownedByRun: true });
			continue;
		}

		if (!TEST_STACK_PREFIXES.some(function(prefix) { return(name.startsWith(prefix)); })) {
			continue;
		}

		const lastUpdate = summary.lastUpdate === undefined ? Number.NaN : Date.parse(summary.lastUpdate);
		const createdMatch = /-(\d{13})$/.exec(name);
		const createdAt = createdMatch === null ? Number.NaN : Number(createdMatch[1]);
		const touchedAt = Math.max(...[lastUpdate, createdAt].filter(Number.isFinite));
		if (!Number.isFinite(touchedAt)) {
			console.warn(`Skipping stack ${name}: neither its last update nor its name gives its age`);
			continue;
		}

		const ageMs = options.now - touchedAt;
		if (ageMs > options.maxAgeMs) {
			selected.push({ name, reason: `stale: last touched ${Math.round(ageMs / 60_000)} minutes ago`, ownedByRun: false });
		}
	}

	return(selected);
}

/**
 * Whether the cleanup may delete a stack's update lock. A lock of this run's
 * stack is stale once the test processes are stopped. Another run's lock is
 * stale only when older than maxAgeMs: a fresh one belongs to a live run.
 * @param stack - The stack, as selectStacksToClean returned it
 * @param lockedAt - When the lock was taken (ms since the epoch), or NaN if unknown
 * @param options.maxAgeMs - Age after which a lock is stale
 * @param options.now - The current time
 */
export function lockIsRemovable(
	stack: StackToClean,
	lockedAt: number,
	options: { maxAgeMs: number; now: number }
): boolean {
	if (stack.ownedByRun) {
		return(true);
	}

	return(Number.isFinite(lockedAt) && options.now - lockedAt > options.maxAgeMs);
}

/**
 * Whether a failed cleanup of a stale stack means another run has the
 * stack: that run holds its lock, or already removed the stack. Concurrent
 * runs clean the same stale stacks, and the run that has the stack
 * destroys it. Reads the error and each of its causes.
 * @param err - The error the cleanup of the stack threw
 */
export function isCleanedByAnotherRun(err: unknown): boolean {
	for (let cause: unknown = err; cause instanceof Error; cause = cause.cause) {
		if (cause instanceof automation.ConcurrentUpdateError || cause instanceof automation.StackNotFoundError) {
			return(true);
		}

		/* Another run removed the stack's checkpoint while this run read it */
		if (/failed to load checkpoint[\s\S]*NotFound/.test(cause.message)) {
			return(true);
		}
	}

	return(false);
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

interface InFlightOperation {
	controller: AbortController;
	/** Settles, never rejects, once the operation ended */
	ended: Promise<void>;
}

/**
 * Operations still running per stack (keyed by workDir and stack name). A
 * test that times out leaves its "up" running; destroyStack cancels it and
 * waits, or the destroy would hit the stack's lock and the "up" would keep
 * creating resources.
 */
const inFlightOperations = new Map<string, InFlightOperation>();

function operationKey(workDir: string, stackName: string): string {
	return(`${workDir}\0${stackName}`);
}

/**
 * Run an operation on a stack and record it until it ends
 * @param run - The operation; it passes the signal to every Pulumi command
 */
async function trackOperation<T>(workDir: string, stackName: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const key = operationKey(workDir, stackName);
	const controller = new AbortController();
	const result = run(controller.signal);
	/* The caller gets the result and its error; this only marks the end */
	const ended = result.then(function() { return(undefined); }, function() { return(undefined); });
	inFlightOperations.set(key, { controller, ended });

	try {
		return(await result);
	} finally {
		inFlightOperations.delete(key);
	}
}

/**
 * Cancel the stack's running operation, if any, and wait until it ended.
 * Aborting sends SIGINT, so Pulumi saves its state and releases the lock.
 */
async function endInFlightOperation(workDir: string, stackName: string): Promise<void> {
	const operation = inFlightOperations.get(operationKey(workDir, stackName));
	if (operation === undefined) {
		return;
	}

	console.log(`Stack ${stackName} has an operation still running; cancelling it and waiting for it to end`);
	operation.controller.abort();
	await operation.ended;
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

	return(await trackOperation(workDir, stackName, async function(signal) {
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

		// A teardown that began during the steps above must not race an "up"
		signal.throwIfAborted();
		const upResult = await stack.up({ onOutput, signal });

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
	}));
}

async function destroyOnce(stack: automation.Stack): Promise<void> {
	const result = await stack.destroy({ onOutput });

	if (result.summary.result !== 'succeeded') {
		throw(new Error(`Destroy of stack ${stack.name} ended with status '${result.summary.result}': ${result.summary.message}`));
	}
}

/**
 * A property of a value read from an exported Pulumi state, or undefined
 */
function propertyOf(value: unknown, key: string): unknown {
	if (typeof value !== 'object' || value === null || !(key in value)) {
		return(undefined);
	}

	return(Object.getOwnPropertyDescriptor(value, key)?.value);
}

/**
 * "<type> <name>" of a pending create in an exported Pulumi state, or
 * undefined for another pending operation
 */
function describePendingCreate(operation: unknown): string | undefined {
	if (propertyOf(operation, 'type') !== 'creating') {
		return(undefined);
	}

	const resource = propertyOf(operation, 'resource');
	const name = propertyOf(propertyOf(resource, 'inputs'), 'name');

	return(`${String(propertyOf(resource, 'type'))} ${typeof name === 'string' ? name : String(propertyOf(resource, 'urn'))}`);
}

/**
 * The resources an interrupted "up" started to create: GCP can hold them
 * while the state does not, so a destroy cannot delete them. Names them for
 * the error message, or returns '' when there are none or the state cannot
 * be read.
 */
async function untrackedResourcesOf(stack: automation.Stack): Promise<string> {
	try {
		const state = await stack.exportStack();
		const pending = propertyOf(state.deployment, 'pending_operations');
		const names = (Array.isArray(pending) ? pending : []).map(describePendingCreate).filter(function(name) {
			return(name !== undefined);
		});

		return(names.length === 0 ? '' : `. Pending creates that the state does not track: ${names.join(', ')}`);
	} catch {
		return('');
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

	await endInFlightOperation(workDir, stackName);

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
			throw(new Error(`Destroy of stack ${stackName} in ${projectDir} failed twice; its resources are still deployed${await untrackedResourcesOf(stack)}`, { cause: retryErr }));
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

	await trackOperation(workDir, stackName, async function(signal) {
		const stack = await automation.LocalWorkspace.selectStack({
			stackName,
			workDir
		});

		signal.throwIfAborted();
		await stack.refresh({ onOutput, signal });
	});
}

/**
 * Preview a Pulumi stack and return the planned operation for each resource
 * @param projectDir - Path to the Pulumi project directory
 * @param stackName - Name of the stack
 * @returns Map of resource URN to planned operation (e.g., "same", "update")
 */
export async function previewStack(projectDir: string, stackName: string): Promise<{ [urn: string]: string }> {
	const workDir = path.resolve(process.cwd(), projectDir);

	return(await trackOperation(workDir, stackName, async function(signal) {
		const stack = await automation.LocalWorkspace.selectStack({
			stackName,
			workDir
		});

		const operations: { [urn: string]: string } = {};
		signal.throwIfAborted();
		await stack.preview({
			onOutput,
			signal,
			onEvent: function(event) {
				const metadata = event.resourcePreEvent?.metadata;
				if (metadata) {
					operations[metadata.urn] = metadata.op;
				}
			}
		});

		return(operations);
	}));
}
