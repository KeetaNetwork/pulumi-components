import * as pulumi from '@pulumi/pulumi';
import * as fs from 'fs';
import * as os from 'os';
import * as child_process from 'child_process';
import * as path from 'path';
import * as process from 'process';
import * as crypto from 'crypto';

import * as utils from '../utils';

/**
 * Create a tarball from a directory, caching it in the home directory
 * and returning the path to the tarball.  If a cacheID is provided, it
 * will be used to cache the tarball.
 */
function createTarballFromDir(directory: string, cacheID?: string, excludePatterns: string[] = []): { file: string, uniqueID: string, shouldClean: boolean } {
	let shouldClean = false;
	if (cacheID === undefined) {
		cacheID = crypto.randomUUID();

		shouldClean = true;
	}

	const tarballDir = path.join(os.homedir(), '.cache', 'pulumi-tarballs');
	fs.mkdirSync(tarballDir, {
		recursive: true
	});

	const canonicalDir = fs.realpathSync(directory);
	const dirHash = utils.hash(canonicalDir, 32);
	cacheID = utils.hash(cacheID, 32);

	const uniqueID = `${dirHash}-${cacheID}`;

	const tarballPath = path.join(tarballDir, `${uniqueID}.tar.gz`);
	const tarballTmpPath = `${tarballPath}.new`;

	if (fs.existsSync(tarballPath)) {
		return({
			uniqueID: uniqueID,
			file: tarballPath,

			/* If we didn't create this tarball, we shouldn't clean it up */
			shouldClean: false
		});
	}

	/**
	 * Create the tarball
	 * --no-xattrs will remove macOS added extended attributes
	 */

	const excludeFlags = excludePatterns.map(function(pattern) {
		return(`--exclude='${pattern}'`);
	});

	const createResults = child_process.spawnSync('tar', [
		'-C', directory,
		...excludeFlags,
		'--no-xattrs',
		'-zcf',
		tarballTmpPath,
		'.'
	], {
		env: {
			...process.env,
			LC_ALL: 'C',
			LANG: 'C'
		}
	});
	if (createResults.status !== 0) {
		throw new Error(`tar failed: ${createResults.stderr.toString()}`);
	}

	/**
	 * Verify that the created tarball is valid
	 */
	const checkResults = child_process.spawnSync('/bin/bash', ['-c', `tar -ztf ${tarballTmpPath} > /dev/null`]);
	if (checkResults.status !== 0) {
		throw new Error(`tar failed: ${checkResults.stderr.toString()}`);
	}

	fs.renameSync(tarballTmpPath, tarballPath);

	return({
		uniqueID: uniqueID,
		file: tarballPath,
		shouldClean: shouldClean
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
		throw new Error(`Could not find commit ${commitID}`);
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
	const canonicalDir = child_process.execSync(`git rev-parse --prefix`, {
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
		throw new Error(`tar failed: ${createResults.stderr.toString()}`);
	}

	/**
	 * Verify that the created tarball is valid
	 */
	const checkResults = child_process.spawnSync('tar', ['-ztf', tarballTmpPath]);
	if (checkResults.status !== 0) {
		throw new Error(`tar failed: ${checkResults.stderr.toString()}`);
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
 * Create a tarball from a directory
 */
export class DirTarballArchive extends pulumi.asset.FileAsset {
	/**
	 * Unique ID for the tarball, based on the cacheID and the directory
	 * it was created from
	 */
	readonly uniqueID: string;

	/**
	 * Should the generated archive be cleaned up because there is no
	 * value in caching it because no cache ID was supplied ?
	 */
	private shouldClean: boolean;

	/**
	 * Path of generated tarball
	 */
	private _path: string;

	constructor(dir: string, cacheID?: string, excludePatterns?: string[]) {
		const { file, uniqueID, shouldClean } = createTarballFromDir(dir, cacheID, excludePatterns);

		super(file);
		this.uniqueID = uniqueID;
		this.shouldClean = shouldClean;
		this._path = file;
	}

	/**
	 * Clean up the generated tarball if it is not cachable
	 */
	clean() {
		if (!this.shouldClean) {
			return;
		}

		try {
			fs.unlinkSync(this._path);
		} catch {
			/* Ignore errors */
		}

		this.shouldClean = false;
	}
}

export default GitTarballArchive;
