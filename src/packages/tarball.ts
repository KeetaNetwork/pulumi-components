import * as pulumi from '@pulumi/pulumi';
import * as fs from 'fs';
import * as os from 'os';
import * as child_process from 'child_process';
import * as path from 'path';
import * as process from 'process';

import * as utils from '../utils';

function createTarballFromGit(directory: string, commitID: string = 'HEAD'): { commit: string, file: string } {
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

	const canonicalDir = fs.realpathSync(directory);
	const dirHash = utils.hash(canonicalDir, 32);
	const tarballPath = path.join(tarballDir, `${dirHash}-${commit}.tar.gz`);
	const tarballTmpPath = `${tarballPath}.new`;

	if (fs.existsSync(tarballPath)) {
		return({
			commit: commit,
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
		file: tarballPath
	});
}

/**
 * Create a tarball from a Git checkout of a directory
 */
export class GitTarballArchive extends pulumi.asset.FileAsset {
	readonly commit: string;

	constructor(dir: string, commitID?: string) {
		const { commit, file } = createTarballFromGit(dir, commitID);

		super(file);
		this.commit = commit;
	}
}
