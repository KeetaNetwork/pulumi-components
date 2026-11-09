import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { expectDefined, expectRecord } from '../helpers/narrow';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageJson = expectRecord(JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')), 'package.json');
const peers = expectRecord(packageJson.peerDependencies, 'the peer dependencies');
const devDependencies = expectRecord(packageJson.devDependencies, 'the dev dependencies');
const readme = fs.readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');

/** The `@pulumi/*` packages that the sources import, whatever the form of the import */
function importedPulumiPackages() {
	const sourceFiles = fs.readdirSync(path.join(repositoryRoot, 'src'), { recursive: true, encoding: 'utf8' }).filter(function(file) {
		return(file.endsWith('.ts'));
	});
	const packages = new Set<string>();
	for (const file of sourceFiles) {
		const text = fs.readFileSync(path.join(repositoryRoot, 'src', file), 'utf8');
		for (const match of text.matchAll(/(?:from|import|require)\s*\(?\s*'(@pulumi\/[a-z-]+)/g)) {
			packages.add(expectDefined(match[1], 'the package of an import'));
		}
	}

	return([ ...packages ].sort());
}

/*
 * The Pulumi packages are peers, so that a program and this library share
 * one copy of each. A package imported by the sources that is not a peer
 * would be a second copy; a peer without a dev dependency could not be
 * tested.
 */
describe('the Pulumi packages of the package', function() {
	const imported = importedPulumiPackages();

	it('are found in the sources', function() {
		expect(imported).toContain('@pulumi/pulumi');
		expect(imported).toContain('@pulumi/gcp');
	});

	it.each(imported)('include %s as a peer dependency and a dev dependency, and not as a dependency', function(name) {
		expect(peers).toHaveProperty([ name ]);
		expect(devDependencies).toHaveProperty([ name ]);
		expect(packageJson.dependencies).not.toHaveProperty([ name ]);
	});

	it('are all imported: no peer is left over', function() {
		expect(Object.keys(peers).sort()).toEqual(imported);
	});

	it.each(Object.entries(peers))('list the range of %s in the README as it is in package.json (%s)', function(name, range) {
		expect(readme).toContain(`\`${name}\` \`${String(range)}\``);
	});

	it('list in the README no range for a package that is not a peer', function() {
		const listed = [ ...readme.matchAll(/`(@pulumi\/[a-z-]+)` `\^[0-9.]+`/g) ].map(function(match) {
			return(match[1]);
		}).sort();

		expect(listed).toEqual(Object.keys(peers).sort());
	});
});
