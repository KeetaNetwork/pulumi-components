import { spawn } from 'child_process';

export function normalizeName(...args: string[]) {
	const joined = args.join('-').toLowerCase();
	return joined.replace(/\.|_/g, '-');
}

interface ExecResponse {
	exitCode: number | null;
	stdout: string[];
	stderr: string[];
}

export function promisifyExec(script: string, args: string[] = []): Promise<ExecResponse> {
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
