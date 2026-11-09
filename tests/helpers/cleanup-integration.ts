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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import {
	currentRunId,
	destroyStack,
	installProjectDependencies,
	selectStacksToClean
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

/**
 * A stack whose update was killed keeps its lock, and a locked stack cannot
 * be destroyed. The cleanup runs after the test process ended, so the lock is
 * stale.
 */
async function releaseStaleLock(workDir: string, stackName: string): Promise<void> {
	const stack = await automation.LocalWorkspace.selectStack({ stackName, workDir });
	console.log(`Stack ${stackName} has an update in progress; cancelling it to release its lock`);
	await stack.cancel();
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

	installProjectDependencies(workDir);

	const failures: string[] = [];
	for (const { name, reason } of toClean) {
		console.log(`${project}: destroying ${name} (${reason})`);
		try {
			const summary = stacks.find(function(candidate) { return(candidate.name === name); });
			if (summary?.updateInProgress === true) {
				await releaseStaleLock(workDir, name);
			}

			await destroyStack(workDir, name);
		} catch (err) {
			console.error(`${project}: failed to destroy ${name}:`, err);
			failures.push(`${project}/${name}`);
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
