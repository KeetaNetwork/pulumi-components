import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

/**
 * Creates temporary directory trees for the tests of the enclosing `describe`
 * and removes all of them after each test.
 */
export function useTempDirectories() {
	const created: string[] = [];

	afterEach(function() {
		for (const directory of created.splice(0)) {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	return({
		/** Creates a directory with the files (written in the order given) and symbolic links `{ [link]: target }` */
		make: function(files: { [relativePath: string]: string }, links: { [relativePath: string]: string } = {}) {
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-test-tree-'));
			created.push(directory);

			for (const [ relativePath, contents ] of Object.entries(files)) {
				const fullPath = path.join(directory, relativePath);
				fs.mkdirSync(path.dirname(fullPath), { recursive: true });
				fs.writeFileSync(fullPath, contents);
			}

			for (const [ relativePath, target ] of Object.entries(links)) {
				const fullPath = path.join(directory, relativePath);
				fs.mkdirSync(path.dirname(fullPath), { recursive: true });
				fs.symlinkSync(target, fullPath);
			}

			return(directory);
		}
	});
}
