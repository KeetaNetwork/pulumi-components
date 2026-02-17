import * as pulumi from '@pulumi/pulumi';
import * as crypto from 'crypto';
import { spawn } from 'child_process';

export type PublicInterface<T> = Pick<T, keyof T>;

export function normalizeName(...args: string[]) {
	const joined = args.join('-').toLowerCase();
	return(joined.replace(/\.|_/g, '-'));
}

interface ExecResponse {
	exitCode: number | null;
	stdout: string[];
	stderr: string[];
}

export function promisifyExec(script: string, args: string[] = [], env?: NodeJS.ProcessEnv): Promise<ExecResponse> {
	return(new Promise(function(resolve, reject) {
		const child = spawn(script, args, {
			env: env
		});

		const resp: ExecResponse = { exitCode: null, stdout: [], stderr: [] };

		for (const type of ['stderr', 'stdout'] as const) {
			child[type].on('data', function(data: Buffer) {
				resp[type].push(data.toString());
			});
		}

		child.on('close', function(exitCode: number) {
			resp.exitCode = exitCode;

			if (exitCode !== 0) {
				reject(new Error(`Command failed with exit code ${exitCode}`));
				return;
			}

			resolve(resp);
		});
	}));
}

export function nonNullable<T>(input: T | undefined | null): T {
	if (input === undefined || input === null) {
		throw(new Error('invalid input, expected non-null value'));
	}

	return(input);
}

export function hash(input: string, length?: number): string;
export function hash(input: Promise<string> | pulumi.Output<string>, length?: number): pulumi.Output<string>;
export function hash(input: pulumi.Input<string>, length?: number): string | pulumi.Output<string>;
export function hash(input: pulumi.Input<string>, length: number = 8): string | pulumi.Output<string> {
	const hashFunction = crypto.createHash('sha256');

	if (typeof(input) === 'string') {
		hashFunction.update(input);
		const hashValue = hashFunction.digest('hex');
		const truncatedHashValue = hashValue.slice(0, length);
		return(truncatedHashValue);
	} else if ('apply' in input) {
		return(input.apply(function(realInput) {
			return(hash(realInput, length));
		}));
	} else {
		return(pulumi.output(input).apply(function(realInput) {
			return(hash(realInput, length));
		}));
	}
}

export function tail(input: string): string;
export function tail(input: pulumi.Output<string>): pulumi.Output<string>;
export function tail(input: string | pulumi.Output<string>): string | pulumi.Output<string>;
export function tail(input: string | pulumi.Output<string>) {
	if (typeof(input) === 'string') {
		const result = input.split('/').slice(-1)[0];
		return(result);
	}

	return(input.apply(function(realInput) {
		return(tail(realInput));
	}));
}

export function inputApply<InnerType, InputType extends pulumi.Input<InnerType>, CallbackType>(input: InputType, callback: (value: pulumi.Unwrap<InputType>) => CallbackType): pulumi.Output<CallbackType> {
	const output = pulumi.output(input);
	const retval = output.apply(callback);
	return(retval);
}

/**
 * Create a resource name that fits within a defined length
 *
 * It will be constructed by hashing the prefix, then including as much of it
 * can as well as 6 characters of the hash, and the entire suffix
 *
 * For example:
 *    Prefix = 'my-very-long-prefix', Suffix = 'vm', MaxLength = 12
 *    Result = 'my-abcdef-vm'
 *
 * @param prefix Prefix to include as much of as possible and hash
 * @param suffix Suffix to always include
 * @param maxLength The maximum length to acheive
 */
export function generateName(prefix: string, suffix: string, maxLength: number) {
	prefix = normalizeName(prefix);
	const prefixMaxLength = maxLength - suffix.length - 1;

	let realPrefix: string = prefix;
	if (realPrefix.length > prefixMaxLength) {
		realPrefix = realPrefix.slice(0, prefixMaxLength - 1 - 6) + hash(realPrefix, 6);
	}

	return(`${realPrefix}-${suffix}`);
}

/**
 * Create a hash with an optional letter prefix
 * @param data Data to hash
 * @param length Length of the hash to return
 * @param addPrefix Whether to add a letter prefix (true), a custom prefix (string), or no prefix (false)
 * @returns Hash string (lowercase)
 */
export function hashWithPrefix(data: string, length = 20, addPrefix: boolean | string = true): string {
	const hashValue = hash(data, length);

	let hashPrefix = '';
	if (addPrefix === true) {
		// Find the first letter in the hash to use as prefix
		const letterMatches = hashValue.match(/[A-Za-z]/g);
		const firstChar = (letterMatches ?? ['a'])[0];
		hashPrefix = firstChar;
	} else if (typeof addPrefix === 'string') {
		hashPrefix = addPrefix;
	}

	const combined = `${hashPrefix}${hashValue}`;
	return(combined.substring(0, length).toLowerCase());
}
