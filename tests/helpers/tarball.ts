import { spawnSync } from 'node:child_process';

function runTar(args: string[]) {
	const result = spawnSync('tar', args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }});
	if (result.status !== 0) {
		throw(new Error(`tar ${args.join(' ')} failed: ${result.stderr}`));
	}

	return(result.stdout);
}

/**
 * The files in a gzip tarball, sorted, without the directory entries and
 * without a leading "./" (so a listing made with `tar -C dir .` and one made
 * with `tar -T list` read the same).
 */
export function listTarballFiles(tarball: string): string[] {
	return(runTar([ '-tzf', tarball ])
		.split('\n')
		.map(function(entry) {
			return(entry.replace(/^\.\//, ''));
		})
		.filter(function(entry) {
			return(entry !== '' && entry !== '.' && !entry.endsWith('/'));
		})
		.sort());
}

/** Extracts a gzip tarball into an existing directory */
export function extractTarball(tarball: string, directory: string): void {
	runTar([ '-xzf', tarball, '-C', directory ]);
}
