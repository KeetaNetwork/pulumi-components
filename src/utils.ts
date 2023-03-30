import * as pulumi from '@pulumi/pulumi';
import * as crypto from 'crypto';
import { spawn } from 'child_process';

export type PublicInterface<T> = Pick<T, keyof T>;

export function normalizeName(...args: string[]) {
	const joined = args.join('-').toLowerCase();
	return joined.replace(/\.|_/g, '-');
}

interface ExecResponse {
	exitCode: number | null;
	stdout: string[];
	stderr: string[];
}

export function promisifyExec(script: string, args: string[] = [], env?: NodeJS.ProcessEnv): Promise<ExecResponse> {
	return new Promise(function(resolve, reject) {
		const child = spawn(script, args, {
			env: env
		});

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

export function nonNullable<T>(input: T | undefined | null): T {
	if (input === undefined || input === null) {
		throw(new Error('invalid input, expected non-null value'));
	}

	return(input);
}

export function hash(input: string, length?: number): string;
export function hash(input: pulumi.Output<string>, length?: number): pulumi.Output<string>;
export function hash(input: string | pulumi.Output<string>, length?: number): string | pulumi.Output<string>;
export function hash(input: string | pulumi.Output<string>, length: number = 8): string | pulumi.Output<string> {
	const hashFunction = crypto.createHash('sha256');

	if (typeof(input) === 'string') {
		hashFunction.update(input);
		const hashValue = hashFunction.digest('hex');
		const truncatedHashValue = hashValue.slice(0, length);
		return(truncatedHashValue);
	} else {
		return(input.apply(function(realInput) {
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
