import * as crypto from 'crypto';
import * as pulumi from '@pulumi/pulumi';
import { spawn } from 'child_process';
import type { OutputWrapped } from './types';

export function HashStrings(input: string | (string | undefined)[], length?: number): string;
export function HashStrings(input: pulumi.Output<string | undefined>[], length?: number): pulumi.Output<string>;
export function HashStrings(input: string | (string | undefined)[] | pulumi.Output<string | undefined>[], length?: number): OutputWrapped<string> {
	if (Array.isArray(input)) {
		const firstInput = input[0];

		/**
		 * If the input is an array of pulumi.Output, then process the
		 * hashing after unwrapping
		 */
		if (pulumi.Output.isInstance(firstInput)) {
			const combinedInput = pulumi.all(input);
			return(combinedInput.apply(function(wrappedInput) {
				return(HashStrings(wrappedInput, length));
			}));
		}

		/**
		 * Otherwise, join the values
		 */
		input = input.join(' ');
	}

	const hash = crypto.createHash('sha1');
	hash.update(input);

	let digest = hash.digest('hex');

	if (length !== undefined) {
		digest = digest.slice(0, length);
	}

	return(digest);
}

export function normalizeName(...args: string[]) {
	const joined = args.join('-').toLowerCase();
	return joined.replace(/\.|_/g, '-');
}

interface ExecResponse {
	exitCode: number | null;
	stdout: string[];
	stderr: string[];
}

export function promisifyExec(script: string, args: string[] = []) {
	return new Promise(function(resolve, reject) {
		const child = spawn(script, args);

		const resp: ExecResponse = { exitCode: null, stdout: [], stderr: [] };

		for (const type of ['stderr', 'stdout'] as const) {
			child[type].on('data', function(data) {
				resp[type].push(data.toString());
			});
		}

		child.on('close', function(exitCode: number) {
			resp.exitCode = exitCode;

			if (exitCode !== 0) {
				reject(resp);
				return;
			}

			resolve(resp);
		});
	});
}
