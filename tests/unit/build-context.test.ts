import { describe, expect, it } from 'vitest';

import type * as buildContext from '../../src/packages/build-context';
import type * as tarball from '../../src/packages/tarball';
import { listTarballFiles } from '../helpers/tarball';
import { useTempDirectories } from '../helpers/temp-directories';
import { requireSource } from './harness/load-sources';
import { useIsolatedHome } from './harness/pulumi-tree';

const { loadBuildContext, fingerprintBuildContext } = requireSource<typeof buildContext>('src/packages/build-context.ts');
const { DirTarballArchive } = requireSource<typeof tarball>('src/packages/tarball.ts');

interface Files {
	[relativePath: string]: string;
}

const temp = useTempDirectories();

function filesOf(files: Files, options?: Parameters<typeof loadBuildContext>[1]) {
	return(loadBuildContext(temp.make(files), options).files);
}

/*
 * What goes to Docker is what `.dockerignore` and the caller's patterns leave
 * of the directory, plus the two files Docker always needs.
 */
describe('loadBuildContext', function() {
	const base: Files = { 'Dockerfile': 'FROM scratch', 'src/index.js': 'x', 'README.md': 'readme', 'NOTES.md': 'notes' };

	const dockerignoreRows: [ string, Files, string[] ][] = [
		[ 'no .dockerignore keeps every file', {}, [ 'NOTES.md', 'README.md', 'src/index.js' ] ],
		[ 'a file pattern removes the matches', { '.dockerignore': '*.md' }, [ 'src/index.js' ] ],
		[ 'a directory pattern removes the directory', { '.dockerignore': 'src' }, [ 'NOTES.md', 'README.md' ] ],
		[ 'a "!" line re-includes a path an earlier line removed', { '.dockerignore': '*.md\n!README.md' }, [ 'README.md', 'src/index.js' ] ],
		[ 'comments and blank lines are ignored', { '.dockerignore': '# notes\n\nNOTES.md\n' }, [ 'README.md', 'src/index.js' ] ],
		[ 'a "**" pattern reaches nested files', { '.dockerignore': '**/*.js' }, [ 'NOTES.md', 'README.md' ] ]
	];

	it.each(dockerignoreRows)('%s', function(_description, extra, expected) {
		const context = loadBuildContext(temp.make({ ...base, ...extra }));
		const withoutAlwaysIncluded = context.files.filter(function(file) {
			return(file !== 'Dockerfile' && file !== '.dockerignore');
		});

		expect(withoutAlwaysIncluded).toEqual(expected);
	});

	it('excludes node_modules, at the root and nested, when .dockerignore lists it', function() {
		const files = filesOf({
			'.dockerignore': 'node_modules\n**/node_modules',
			'Dockerfile': 'FROM scratch',
			'node_modules/dep/index.js': 'x',
			'packages/app/node_modules/dep/index.js': 'x',
			'packages/app/index.js': 'x'
		});

		expect(files).toEqual([ '.dockerignore', 'Dockerfile', 'packages/app/index.js' ]);
	});

	it('removes the files the caller excludes, on top of .dockerignore', function() {
		const files = filesOf({ '.dockerignore': '*.md', 'Dockerfile': 'FROM scratch', 'a.md': '1', 'b.txt': '2', 'c.log': '3' }, { excludePatterns: [ 'c.log' ] });

		expect(files).toEqual([ '.dockerignore', 'Dockerfile', 'b.txt' ]);
	});

	it('always includes .dockerignore and the Dockerfile, even when .dockerignore removes everything', function() {
		const files = filesOf({ '.dockerignore': '*\n', 'Dockerfile': 'FROM scratch', 'a.txt': '1' });

		expect(files).toEqual([ '.dockerignore', 'Dockerfile' ]);
	});

	it('always includes a Dockerfile at the path the caller names', function() {
		const files = filesOf({ '.dockerignore': 'build', 'build/Dockerfile.prod': 'FROM scratch', 'build/other': '1', 'a.txt': '1' }, { dockerfilePath: 'build/Dockerfile.prod' });

		expect(files).toEqual([ '.dockerignore', 'a.txt', 'build/Dockerfile.prod' ]);
	});

	it('lists the files sorted, whatever order they were created in', function() {
		const forward: Files = { 'Dockerfile': 'FROM scratch', 'b/2.txt': '2', 'a/1.txt': '1', 'c.txt': '3' };
		const backward = Object.fromEntries(Object.entries(forward).reverse());

		expect(filesOf(backward)).toEqual(filesOf(forward));
		expect(filesOf(forward)).toEqual([ 'Dockerfile', 'a/1.txt', 'b/2.txt', 'c.txt' ]);
	});

	it('includes a symbolic link as a link: the link itself, and nothing behind a linked directory', function() {
		const directory = temp.make({ 'Dockerfile': 'FROM scratch', 'target.txt': 'target', 'real/inner.txt': 'inner' }, { 'link.txt': 'target.txt', 'linked-dir': 'real' });
		const context = loadBuildContext(directory);

		expect(context.files).toEqual([ 'Dockerfile', 'link.txt', 'linked-dir', 'real/inner.txt', 'target.txt' ]);
	});
});

describe('fingerprintBuildContext', function() {
	const files: Files = { 'Dockerfile': 'FROM scratch', 'src/a.js': 'a', 'src/b.js': 'b', 'ignored.log': 'noise', '.dockerignore': '*.log' };

	function fingerprintOf(directory: string) {
		return(fingerprintBuildContext(loadBuildContext(directory)));
	}

	it('is a sha256 hex digest', function() {
		expect(fingerprintOf(temp.make(files))).toMatch(/^[0-9a-f]{64}$/);
	});

	it('is the same for two copies of a directory, whatever order they were written in', function() {
		const first = temp.make(files);
		const second = temp.make(Object.fromEntries(Object.entries(files).reverse()));

		expect(fingerprintOf(first)).toBe(fingerprintOf(second));
	});

	const changes: [ string, Files ][] = [
		[ 'a file changes', { ...files, 'src/a.js': 'changed' } ],
		[ 'a file is renamed', { 'Dockerfile': 'FROM scratch', 'src/a.js': 'a', 'src/renamed.js': 'b', 'ignored.log': 'noise', '.dockerignore': '*.log' } ],
		[ 'a file is added', { ...files, 'src/c.js': 'c' } ],
		[ 'the Dockerfile changes', { ...files, 'Dockerfile': 'FROM busybox' } ],
		[ '.dockerignore stops ignoring a file', { ...files, '.dockerignore': '' } ]
	];

	it.each(changes)('changes when %s', function(_description, changed) {
		expect(fingerprintOf(temp.make(changed))).not.toBe(fingerprintOf(temp.make(files)));
	});

	it('does not change when only an ignored file changes', function() {
		expect(fingerprintOf(temp.make({ ...files, 'ignored.log': 'other noise' }))).toBe(fingerprintOf(temp.make(files)));
	});

	it('changes when a symbolic link points somewhere else', function() {
		const targets: Files = { 'Dockerfile': 'FROM scratch', 'one.txt': 'one', 'two.txt': 'two' };
		const toOne = temp.make(targets, { link: 'one.txt' });
		const toTwo = temp.make(targets, { link: 'two.txt' });

		expect(fingerprintOf(toOne)).not.toBe(fingerprintOf(toTwo));
	});
});

describe('tarball of a build context', function() {
	useIsolatedHome();

	const rows: [ string, Files, { [link: string]: string }, string[] | undefined ][] = [
		[ 'plain files', { 'Dockerfile': 'FROM scratch', 'src/a.js': 'a', 'b.txt': 'b' }, {}, undefined ],
		[ 'files removed by .dockerignore', { '.dockerignore': '*.log\nsecret', 'Dockerfile': 'FROM scratch', 'a.log': '1', 'secret/key': '2', 'src/a.js': 'a' }, {}, undefined ],
		[ 'files removed by excludePatterns', { 'Dockerfile': 'FROM scratch', 'a.txt': '1', 'skip.txt': '2' }, {}, [ 'skip.txt' ] ],
		[ 'a symbolic link and a linked directory', { 'Dockerfile': 'FROM scratch', 'target.txt': 't', 'real/inner.txt': 'i' }, { 'link.txt': 'target.txt', 'linked-dir': 'real' }, undefined ]
	];

	it.each(rows)('holds exactly the files of the context: %s', async function(_description, files, links, excludePatterns) {
		const directory = temp.make(files, links);
		const context = loadBuildContext(directory, { excludePatterns });
		const archive = new DirTarballArchive(directory, 'cache-id', excludePatterns);

		expect(listTarballFiles(await archive.path)).toEqual(context.files);
	});
});
