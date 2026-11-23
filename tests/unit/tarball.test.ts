import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import type * as buildContext from '../../src/packages/build-context';
import type * as tarball from '../../src/packages/tarball';
import { extractTarball, listTarballFiles } from '../helpers/tarball';
import { useTempDirectories } from '../helpers/temp-directories';
import { requireSource } from './harness/load-sources';
import { useIsolatedHome } from './harness/pulumi-tree';

const { DirTarballArchive } = requireSource<typeof tarball>('src/packages/tarball.ts');
const { loadBuildContext } = requireSource<typeof buildContext>('src/packages/build-context.ts');

const temp = useTempDirectories();

/*
 * The tarball of a directory is cached under the home directory. The cache
 * key follows the contents, so a changed source is never handed the tarball
 * of the old source.
 */
describe('DirTarballArchive cache', function() {
	useIsolatedHome();

	async function contentsOfFileInTarball(archive: InstanceType<typeof DirTarballArchive>, file: string) {
		const extracted = temp.make({});
		extractTarball(await archive.path, extracted);

		return(fs.readFileSync(`${extracted}/${file}`, 'utf8'));
	}

	it('reuses the tarball while the contents are unchanged', async function() {
		const directory = temp.make({ 'Dockerfile': 'FROM scratch', 'a.txt': 'one' });

		const first = new DirTarballArchive(directory);
		const second = new DirTarballArchive(directory);

		expect(await second.path).toBe(await first.path);
	});

	it('builds a new tarball with the new contents when a file changed', async function() {
		const directory = temp.make({ 'Dockerfile': 'FROM scratch', 'a.txt': 'one' });
		const before = new DirTarballArchive(directory);
		expect(await contentsOfFileInTarball(before, 'a.txt')).toBe('one');

		fs.writeFileSync(`${directory}/a.txt`, 'two');
		const after = new DirTarballArchive(directory);

		expect(await contentsOfFileInTarball(after, 'a.txt')).toBe('two');
		expect(await after.path).not.toBe(await before.path);
	});

	it('builds a new tarball when a file is added', async function() {
		const directory = temp.make({ 'Dockerfile': 'FROM scratch' });
		const before = new DirTarballArchive(directory);

		fs.writeFileSync(`${directory}/added.txt`, 'new');
		const after = new DirTarballArchive(directory);

		expect(listTarballFiles(await after.path)).toContain('added.txt');
		expect(await after.path).not.toBe(await before.path);
	});

	it('does not rebuild the tarball when only an excluded file changed', async function() {
		const directory = temp.make({ 'Dockerfile': 'FROM scratch', 'a.txt': 'one', 'skip.log': 'noise' });
		const before = new DirTarballArchive(directory, { excludePatterns: [ 'skip.log' ] });

		fs.writeFileSync(`${directory}/skip.log`, 'other noise');
		const after = new DirTarballArchive(directory, { excludePatterns: [ 'skip.log' ] });

		expect(await after.path).toBe(await before.path);
	});

	it('archives the build context it is given without reading the directory again', async function() {
		const directory = temp.make({ 'Dockerfile': 'FROM scratch', 'a.txt': 'one' });
		const context = loadBuildContext(directory, {});

		fs.writeFileSync(`${directory}/added.txt`, 'new');
		const archive = new DirTarballArchive(directory, { context });

		expect(listTarballFiles(await archive.path)).toEqual(context.files);
	});
});
