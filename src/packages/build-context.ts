import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ignore from '@balena/dockerignore';

export interface BuildContextOptions {
	/**
	 * Patterns for files to leave out on top of ".dockerignore". They
	 * match at any depth, as the "--exclude" patterns of "tar" did
	 */
	excludePatterns?: string[];

	/**
	 * Path of the Dockerfile relative to the directory (default: "Dockerfile")
	 */
	dockerfilePath?: string;
}

/**
 * The files that make up a Docker build context: what ".dockerignore" and
 * the caller's patterns leave of a directory, plus ".dockerignore" and the
 * Dockerfile, which Docker always needs. The fingerprint and the tarball
 * are both made from this one list.
 */
export interface BuildContext {
	readonly root: string;

	/**
	 * Relative POSIX paths of files and symbolic links, sorted. Directories
	 * are not listed, and nothing behind a linked directory is.
	 */
	readonly files: readonly string[];

	/** Path of the Dockerfile relative to `root` */
	readonly dockerfile: string;
}

const DOCKERIGNORE = '.dockerignore';

function readDockerignoreLines(root: string) {
	let contents: string;
	try {
		contents = fs.readFileSync(path.join(root, DOCKERIGNORE), 'utf8');
	} catch (readError) {
		if (readError instanceof Error && 'code' in readError && readError.code === 'ENOENT') {
			return([]);
		}

		throw(readError);
	}

	return(contents.split(/\r?\n/).map(function(line) {
		return(line.trim());
	}).filter(function(line) {
		return(line !== '' && !line.startsWith('#'));
	}));
}

function matchAnywhere(pattern: string) {
	if (pattern.startsWith('!') || pattern.startsWith('/') || pattern.startsWith('**/')) {
		return([ pattern ]);
	}

	return([ pattern, `**/${pattern}` ]);
}

function normalizeDockerfilePath(dockerfilePath: string) {
	const normalized = path.posix.normalize(dockerfilePath.split(path.sep).join('/'));
	if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
		throw(new Error(`The Dockerfile ${dockerfilePath} is not inside the build directory`));
	}

	return(normalized);
}

function exists(fullPath: string) {
	try {
		fs.lstatSync(fullPath);
	} catch {
		return(false);
	}

	return(true);
}

/**
 * Decide which files of `directory` are part of its Docker build context
 */
export function loadBuildContext(directory: string, options: BuildContextOptions = {}): BuildContext {
	const root = path.resolve(directory);
	const dockerfile = normalizeDockerfilePath(options.dockerfilePath ?? 'Dockerfile');

	const dockerignoreLines = readDockerignoreLines(root);
	const excludeLines = (options.excludePatterns ?? []).flatMap(matchAnywhere);
	const rules = ignore().add([ ...dockerignoreLines, ...excludeLines ]);

	/* A directory that is ignored can still hold a file that a "!" line brings back */
	const canSkipIgnoredDirectories = ![ ...dockerignoreLines, ...excludeLines ].some(function(line) {
		return(line.startsWith('!'));
	});

	const found = new Set<string>();

	function walk(relativeDirectory: string) {
		const entries = fs.readdirSync(path.join(root, relativeDirectory), { withFileTypes: true });
		for (const entry of entries) {
			const relativePath = path.posix.join(relativeDirectory, entry.name);
			const ignored = rules.ignores(relativePath);

			if (entry.isDirectory()) {
				if (!ignored || !canSkipIgnoredDirectories) {
					walk(relativePath);
				}
			} else if (!ignored && (entry.isFile() || entry.isSymbolicLink())) {
				found.add(relativePath);
			}
		}
	}

	walk('');

	for (const required of [ DOCKERIGNORE, dockerfile ]) {
		if (exists(path.join(root, required))) {
			found.add(required);
		}
	}

	const files = [ ...found ].sort(function(a, b) {
		if (a < b) {
			return(-1);
		}

		if (a > b) {
			return(1);
		}

		return(0);
	});

	return({ root, files, dockerfile });
}

/**
 * A SHA-256 hex digest of the paths and contents (or link targets) of the
 * files of the build context. Two directories with the same context have
 * the same fingerprint, wherever they are and whatever order their files
 * were created in.
 */
export function fingerprintBuildContext(context: BuildContext): string {
	const fingerprint = crypto.createHash('sha256');

	for (const file of context.files) {
		const fullPath = path.join(context.root, file);
		const info = fs.lstatSync(fullPath);

		if (info.isSymbolicLink()) {
			fingerprint.update(`link:${file}\0${fs.readlinkSync(fullPath)}\0`);
			continue;
		}

		const contents = fs.readFileSync(fullPath);

		/* The owner's execute bit is kept by "COPY"; the other mode bits differ between machines */
		fingerprint.update(`file:${file}\0${info.mode & 0o100}\0${contents.length}\0`);
		fingerprint.update(contents);
	}

	return(fingerprint.digest('hex'));
}
