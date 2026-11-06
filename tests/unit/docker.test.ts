import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getFileResourceIdentifier } from '../../src/packages/docker';

function makeDirectory(files: { [relativePath: string]: string }) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-hash-test-'));
	for (const [relativePath, contents] of Object.entries(files)) {
		const fullPath = path.join(directory, relativePath);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, contents);
	}

	return(directory);
}

describe('getFileResourceIdentifier', function() {
	it('does not depend on the order files were created in', function() {
		const first = makeDirectory({ 'a.txt': 'a', 'b/c.txt': 'c' });
		const second = makeDirectory({ 'b/c.txt': 'c', 'a.txt': 'a' });

		expect(getFileResourceIdentifier(first)).toBe(getFileResourceIdentifier(second));
	});

	it('changes when a file is renamed or moved', function() {
		const original = makeDirectory({ 'a.txt': 'a', 'b/c.txt': 'c' });
		const renamed = makeDirectory({ 'a.txt': 'a', 'b/d.txt': 'c' });
		const moved = makeDirectory({ 'a.txt': 'a', 'c.txt': 'c' });

		expect(getFileResourceIdentifier(renamed)).not.toBe(getFileResourceIdentifier(original));
		expect(getFileResourceIdentifier(moved)).not.toBe(getFileResourceIdentifier(original));
	});
});
