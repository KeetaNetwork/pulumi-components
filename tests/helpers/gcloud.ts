import { execFileSync } from 'node:child_process';

export function gcloud(args: string[]): string {
	return(execFileSync('gcloud', args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		maxBuffer: 64 * 1024 * 1024
	}));
}

export interface ManagedInstance {
	name: string;
	zone: string;
}

export function listManagedInstances(project: string, region: string, migName: string): ManagedInstance[] {
	const output = gcloud(['compute', 'instance-groups', 'managed', 'list-instances', migName, '--region', region, '--project', project, '--format', 'json']);
	const entries = JSON.parse(output.trim() === '' ? '[]' : output) as { instance?: string }[];

	return(entries.map(function(entry) {
		// .../projects/<project>/zones/<zone>/instances/<name>
		const parts = (entry.instance ?? '').split('/');
		return({
			name: parts[parts.length - 1] ?? '',
			zone: parts[parts.length - 3] ?? ''
		});
	}));
}

export function getSerialPortOutput(project: string, instance: ManagedInstance): string {
	return(gcloud(['compute', 'instances', 'get-serial-port-output', instance.name, '--zone', instance.zone, '--project', project]));
}

export function resetInstance(project: string, instance: ManagedInstance): void {
	gcloud(['compute', 'instances', 'reset', instance.name, '--zone', instance.zone, '--project', project, '--quiet']);
}

export function readLogs(project: string, filter: string, limit = 5): unknown[] {
	const output = gcloud(['logging', 'read', filter, '--project', project, '--limit', String(limit), '--format', 'json', '--freshness', '1h']);
	return(JSON.parse(output.trim() === '' ? '[]' : output) as unknown[]);
}

/**
 * Timestamp text of the last "Cloud-init ... finished at <date>" line in a serial console output
 */
export function lastCloudInitFinishedAt(serialOutput: string): string | undefined {
	const matches = [...serialOutput.matchAll(/Cloud-init v\. \S+ finished at ([^.]+?)\. Datasource/g)];
	return(matches[matches.length - 1]?.[1]);
}

export async function waitFor<T>(description: string, probe: () => T | undefined, maxAttempts: number, delayMs: number): Promise<T> {
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const result = probe();
			if (result !== undefined) {
				return(result);
			}
		} catch (err) {
			lastError = err;
		}

		await new Promise(function(resolve) { setTimeout(resolve, delayMs); });
	}

	throw(new Error(`Timed out waiting for ${description} after ${maxAttempts} attempts${lastError ? `: ${String(lastError)}` : ''}`));
}
