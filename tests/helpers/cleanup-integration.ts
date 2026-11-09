/*
 * Destroys the Pulumi stacks the integration tests leave behind: every stack
 * of the current GitHub Actions run (GITHUB_RUN_ID), and every older test
 * stack not touched for longer than --max-age-minutes. It tries every stack,
 * and exits non-zero if any destroy failed.
 *
 * Run it with "make cleanup-integration" (add "CLEANUP_ARGS=--dry-run" to
 * only print what it would destroy).
 */
import * as automation from '@pulumi/pulumi/automation/index.js';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import {
	currentRunId,
	destroyStack,
	installProjectDependencies,
	lockIsRemovable,
	selectStacksToClean,
	type StackToClean
} from './pulumi.ts';

/*
 * The job timeout is 120 minutes, so a stack untouched for longer belongs to
 * no live run
 */
const DEFAULT_MAX_AGE_MINUTES = 150;

const EXAMPLES_DIR = path.resolve(import.meta.dirname, '..', '..', 'examples');

interface CleanupOptions {
	dryRun: boolean;
	maxAgeMinutes: number;
}

function parseOptions(argv: string[]): CleanupOptions {
	const { values } = parseArgs({
		args: argv,
		options: {
			'dry-run': { type: 'boolean', default: false },
			'max-age-minutes': { type: 'string', default: String(DEFAULT_MAX_AGE_MINUTES) }
		}
	});

	const maxAgeMinutes = Number(values['max-age-minutes']);
	if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) {
		throw(new Error(`--max-age-minutes must be a positive number, got '${values['max-age-minutes']}'`));
	}

	return({ dryRun: values['dry-run'], maxAgeMinutes });
}

/**
 * Every Pulumi project under "examples": the projects the tests deploy
 */
function exampleProjects(): string[] {
	return(fs.readdirSync(EXAMPLES_DIR, { withFileTypes: true }).filter(function(entry) {
		return(entry.isDirectory() && fs.existsSync(path.join(EXAMPLES_DIR, entry.name, 'Pulumi.yaml')));
	}).map(function(entry) {
		return(path.join(EXAMPLES_DIR, entry.name));
	}));
}

interface StackLock {
	url: string;
	/** When the lock was written (ms since the epoch), NaN if unknown */
	lockedAt: number;
}

function gcloudStorage(args: string[]): string {
	return(execFileSync('gcloud', ['storage', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

/**
 * The lock objects of a stack in the gs:// state backend. Pulumi's "cancel"
 * does not release them there, so the cleanup deletes them itself.
 * @param lockDir - gs:// URL of the stack's lock directory, ending in "/"
 */
function listLocks(lockDir: string): StackLock[] {
	let listing: string;
	try {
		listing = gcloudStorage(['ls', '-l', lockDir]);
	} catch (err) {
		const stderr = err instanceof Error && 'stderr' in err ? String(err.stderr) : '';
		if (stderr.includes('matched no objects')) {
			return([]);
		}

		throw(err);
	}

	const locks: StackLock[] = [];
	for (const line of listing.split('\n')) {
		/* "<size>  <creation time>  <url>"; the "TOTAL:" line has no URL */
		const match = /^\s*\d+\s+(\S+)\s+(gs:\/\/\S+)\s*$/.exec(line);
		if (match !== null) {
			locks.push({ url: match[2], lockedAt: Date.parse(match[1]) });
		} else if (line.includes('gs://')) {
			throw(new Error(`Unexpected line in the lock listing of ${lockDir}: '${line}'`));
		}
	}

	return(locks);
}

/**
 * Delete the stack's locks, so the destroy can take the stack. Deletes
 * nothing, and returns false, when one of them belongs to a live run.
 */
function releaseStaleLocks(lockDir: string, stack: StackToClean, options: CleanupOptions): boolean {
	const locks = listLocks(lockDir);
	const lockOptions = { maxAgeMs: options.maxAgeMinutes * 60_000, now: Date.now() };

	const liveLock = locks.find(function(lock) { return(!lockIsRemovable(stack, lock.lockedAt, lockOptions)); });
	if (liveLock !== undefined) {
		console.log(`Stack ${stack.name} is locked by a live run (${liveLock.url}); leaving it alone`);

		return(false);
	}

	for (const lock of locks) {
		console.log(`Stack ${stack.name}: deleting stale lock ${lock.url}`);
		gcloudStorage(['rm', lock.url]);
	}

	return(true);
}

/**
 * gs:// URL of the lock directory of each stack of a project
 */
async function lockDirectoryOf(workspace: automation.LocalWorkspace): Promise<(stackName: string) => string> {
	const backendUrl = (await workspace.whoAmI()).url;
	if (backendUrl === undefined || !backendUrl.startsWith('gs://')) {
		throw(new Error(`The cleanup handles locks of a gs:// state backend only, the backend is '${backendUrl}'`));
	}

	const project = (await workspace.projectSettings()).name;
	const base = `${backendUrl.replace(/\/+$/, '')}/.pulumi/locks/organization/${project}`;

	return(function(stackName) {
		return(`${base}/${stackName}/`);
	});
}

/**
 * Destroy the selected stacks of one project
 * @returns The failures, one message per stack that could not be destroyed
 */
async function cleanProject(workDir: string, options: CleanupOptions, runId: string | undefined): Promise<string[]> {
	const workspace = await automation.LocalWorkspace.create({ workDir });
	const stacks = await workspace.listStacks();
	const toClean = selectStacksToClean(stacks, {
		runId,
		maxAgeMs: options.maxAgeMinutes * 60_000,
		now: Date.now()
	});

	const project = path.basename(workDir);
	console.log(`${project}: ${stacks.length} stack(s), ${toClean.length} to destroy`);
	if (toClean.length === 0 || options.dryRun) {
		for (const { name, reason } of toClean) {
			console.log(`  would destroy ${name} (${reason})`);
		}

		return([]);
	}

	const lockDirectory = await lockDirectoryOf(workspace);
	installProjectDependencies(workDir);

	const failures: string[] = [];
	for (const stack of toClean) {
		console.log(`${project}: destroying ${stack.name} (${stack.reason})`);
		try {
			if (!releaseStaleLocks(lockDirectory(stack.name), stack, options)) {
				continue;
			}

			await destroyStack(workDir, stack.name);
		} catch (err) {
			console.error(`${project}: failed to destroy ${stack.name}:`, err);
			failures.push(`${project}/${stack.name}`);
		}
	}

	return(failures);
}

async function main(): Promise<number> {
	const options = parseOptions(process.argv.slice(2));
	const runId = currentRunId();
	if (runId === undefined) {
		console.log('GITHUB_RUN_ID is not set: only stale stacks are destroyed');
	}

	const failures: string[] = [];
	for (const workDir of exampleProjects()) {
		try {
			failures.push(...await cleanProject(workDir, options, runId));
		} catch (err) {
			console.error(`${path.basename(workDir)}: failed to list or clean stacks:`, err);
			failures.push(`${path.basename(workDir)} (listing)`);
		}
	}

	if (failures.length > 0) {
		console.error(`Cleanup failed for: ${failures.join(', ')}`);

		return(1);
	}

	return(0);
}

main().then(function(code) {
	process.exitCode = code;
}, function(err: unknown) {
	console.error(err);
	process.exitCode = 1;
});
