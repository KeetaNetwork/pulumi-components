import * as pulumi from '@pulumi/pulumi';
import * as fs from 'fs';
import * as os from 'os';
import * as child_process from 'child_process';
import * as path from 'path';
import * as process from 'process';

import * as utils from '../utils';
import { fingerprintBuildContext, loadBuildContext } from './build-context';
import type { BuildContext } from './build-context';

/** The environment for `tar`: the caller's, with a fixed locale so file names are read the same everywhere */
function tarEnvironment(): NodeJS.ProcessEnv {
	return({
		...process.env,
		LC_ALL: 'C',
		LANG: 'C'
	});
}

/* Fixed system directories only, so a writable directory early in PATH cannot supply its own "tar" */
const TAR_DIRECTORIES = [ '/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin' ];

/** The absolute path of the system `tar` */
function tarCommand(): string {
	for (const directory of TAR_DIRECTORIES) {
		const candidate = path.join(directory, 'tar');
		if (fs.existsSync(candidate)) {
			return(candidate);
		}
	}

	throw(new Error(`tar was not found in ${TAR_DIRECTORIES.join(', ')}`));
}

/**
 * Write the tarball of the build context in `runDir`, check it, and move
 * it to `tarballPath`. The rename is atomic, so a reader sees no tarball
 * or a complete one.
 */
function writeTarball(context: BuildContext, runDir: string, tarballPath: string) {
	const tarballTmpPath = path.join(runDir, 'tarball.tar.gz');
	const fileListPath = path.join(runDir, 'files.list');

	/**
	 * Create the tarball from the list of files, which is NUL separated
	 * so that no file name is read as an option
	 * --no-xattrs will remove macOS added extended attributes
	 */
	fs.writeFileSync(fileListPath, context.files.map(function(file) {
		return(`${file}\0`);
	}).join(''));

	const createResults = child_process.spawnSync(tarCommand(), [
		'-C', context.root,
		'--no-xattrs',
		'--null',
		'-T', fileListPath,
		'-zcf',
		tarballTmpPath
	], { env: tarEnvironment() });
	if (createResults.status !== 0) {
		throw(new Error(`tar failed: ${createResults.stderr.toString()}`));
	}

	/**
	 * Verify that the created tarball is valid
	 */
	const checkResults = child_process.spawnSync(tarCommand(), [ '-ztf', tarballTmpPath ], { env: tarEnvironment() });
	if (checkResults.status !== 0) {
		throw(new Error(`tar failed: ${checkResults.stderr.toString()}`));
	}

	fs.renameSync(tarballTmpPath, tarballPath);
}

export interface DirTarballOptions {
	/**
	 * Patterns for files to leave out on top of ".dockerignore"
	 */
	excludePatterns?: string[];

	/**
	 * Dockerfile relative to the directory, which is always archived
	 */
	dockerfilePath?: string;

	/**
	 * The build context of the directory, loaded with the same options.
	 * When given, the directory is not read again.
	 */
	context?: BuildContext;
}

/**
 * Create a tarball of the build context of a directory, cache it in the
 * home directory, and return the path to the tarball. The tarball holds
 * exactly the files of the context (the ones its fingerprint is made from).
 * Its path follows that fingerprint, so a changed source gets a tarball of
 * its own.
 */
function createTarballFromDir(directory: string, options: DirTarballOptions): { file: string, uniqueID: string } {
	const context = options.context ?? loadBuildContext(directory, { excludePatterns: options.excludePatterns, dockerfilePath: options.dockerfilePath });

	const tarballDir = path.join(os.homedir(), '.cache', 'pulumi-tarballs');
	fs.mkdirSync(tarballDir, {
		recursive: true
	});

	const canonicalDir = fs.realpathSync(directory);
	const dirHash = utils.hash(canonicalDir, 32);

	const uniqueID = `${dirHash}-${fingerprintBuildContext(context)}`;

	const tarballPath = path.join(tarballDir, `${uniqueID}.tar.gz`);

	if (fs.existsSync(tarballPath)) {
		return({
			uniqueID: uniqueID,
			file: tarballPath
		});
	}

	/* Each run writes its file list and tarball in a directory of its own, so concurrent deploys of one directory do not share them */
	const runDir = fs.mkdtempSync(path.join(tarballDir, 'run-'));
	try {
		writeTarball(context, runDir, tarballPath);
	} finally {
		fs.rmSync(runDir, { recursive: true, force: true });
	}

	return({
		uniqueID: uniqueID,
		file: tarballPath
	});
}

/**
 * Create a tarball from a git commit of a directory.  This will
 * cache the tarball in the home directory and return the path to
 * the tarball.
 */
function createTarballFromGit(directory: string, commitID: string = 'HEAD'): { commit: string, file: string, uniqueID: string } {
	let commit: string;
	if (commitID === 'HEAD') {
		commit = child_process.execSync(`git log --max-count=1 --format=%H ${commitID} .`, {
			cwd: directory
		}).toString().trim();
	} else {
		commit = child_process.execSync(`git rev-parse ${commitID}`, {
			cwd: directory
		}).toString().trim();
	}

	if (!commit) {
		throw(new Error(`Could not find commit ${commitID}`));
	}

	/**
	 * Cache the resultant tarball in the home directory so we don't
	 * need to rebuild it every time
	 *
	 * XXX:TODO: Clean up old tarballs
	 */
	const tarballDir = path.join(os.homedir(), '.cache', 'pulumi-tarballs');
	fs.mkdirSync(tarballDir, {
		recursive: true
	});

	/**
	 * Get the canonical directory name, which is the path to the
	 * directory within the git repository
	 */
	const canonicalDir = child_process.execSync('git rev-parse --show-prefix', {
		cwd: directory
	}).toString().trim();
	const dirHash = utils.hash(canonicalDir, 32);

	const uniqueID = `${dirHash}-${commit}`;

	const tarballPath = path.join(tarballDir, `${uniqueID}.tar.gz`);
	const tarballTmpPath = `${tarballPath}.new`;

	if (fs.existsSync(tarballPath)) {
		return({
			commit: commit,
			uniqueID: uniqueID,
			file: tarballPath
		});
	}

	try {
		fs.unlinkSync(tarballTmpPath);
	} catch {
		/* Ignore this error, if we can't actually create the file we'll fail below */
	}

	/**
	 * Create the tarball in a deterministic way so that if it has the
	 * same contents it will always be the same hash
	 */
	const createResults = child_process.spawnSync('git', ['-c', 'tar.umask=0022', 'archive', '--format=tar.gz', `--output=${tarballTmpPath}`, commit, '.'], {
		cwd: directory,
		env: {
			...process.env,
			LC_ALL: 'C',
			LANG: 'C'
		}
	});
	if (createResults.status !== 0) {
		throw(new Error(`tar failed: ${createResults.stderr.toString()}`));
	}

	/**
	 * Verify that the created tarball is valid
	 */
	const checkResults = child_process.spawnSync('tar', ['-ztf', tarballTmpPath]);
	if (checkResults.status !== 0) {
		throw(new Error(`tar failed: ${checkResults.stderr.toString()}`));
	}

	fs.renameSync(tarballTmpPath, tarballPath);

	return({
		commit: commit,
		uniqueID: uniqueID,
		file: tarballPath
	});
}

/**
 * Create a tarball from a Git checkout of a directory
 */
export class GitTarballArchive extends pulumi.asset.FileAsset {
	/**
	 * Fully resolved commit
	 */
	readonly commit: string;

	/**
	 * Unique ID for the tarball, based on the commit and the directory
	 * it was created from
	 */
	readonly uniqueID: string;

	constructor(dir: string, commitID?: string) {
		const { commit, file, uniqueID } = createTarballFromGit(dir, commitID);

		super(file);
		this.commit = commit;
		this.uniqueID = uniqueID;
	}

	clean() {
		/* Do nothing, but have the same interface as DirTarballArchive */
	}
}

/**
 * Create a tarball from a directory. The tarball is cached by the build
 * context's fingerprint and kept for reuse.
 */
export class DirTarballArchive extends pulumi.asset.FileAsset {
	/**
	 * Unique ID for the tarball, based on the build context and the
	 * directory it was created from
	 */
	readonly uniqueID: string;

	/**
	 * @param dir Directory to archive (".dockerignore" is applied to it)
	 * @param options What to leave out, the Dockerfile, and the build context if already loaded
	 */
	constructor(dir: string, options: DirTarballOptions = {}) {
		const { file, uniqueID } = createTarballFromDir(dir, options);

		super(file);
		this.uniqueID = uniqueID;
	}

	clean() {
		/* Do nothing: the tarball is cached for the next deploy, and this keeps the interface of GitTarballArchive */
	}
}

/** @internal */
export const _Testing = {
	tarCommand
};

export default GitTarballArchive;
