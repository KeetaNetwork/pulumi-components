import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const DEFAULTS_FILE = path.join('packages', 'gcp', 'defaults.ts');

/** String and number literals of the code of a file (not its comments) */
function literalsOf(source: string): unknown[] {
	const found: unknown[] = [];

	function visit(node: ts.Node) {
		/* A literal type such as 'POSTGRES_18' in a union names a value, it does not choose one */
		if (ts.isTypeNode(node)) {
			return;
		}

		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			found.push(node.text);
		} else if (ts.isNumericLiteral(node)) {
			found.push(Number(node.text));
		}

		ts.forEachChild(node, visit);
	}

	visit(ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true));

	return(found);
}

/*
 * The snapshot sees the values that reach Pulumi, not where the code takes
 * them from. A literal that is left behind in a component would drift from
 * the module without any test noticing, so the sources are read for them.
 */
describe('default values have one home', function() {
	/* P13 adds a table of Cloud SQL tiers, which will name 'db-f1-micro'; that phase moves this one row */
	const literals: unknown[] = [ '10.97.35.0/24', '10.97.36.0/28', 'POSTGRES_18', 'E2_HIGHCPU_8', 'linux/amd64', 'db-f1-micro', '35.235.240.0/20', 25000, 4500, 28800 ];

	const sourceFiles = fs.readdirSync(SOURCE_DIRECTORY, { recursive: true, encoding: 'utf8' }).filter(function(file) {
		return(file.endsWith('.ts') && !file.endsWith(DEFAULTS_FILE));
	}).sort();

	it('reads the sources', function() {
		expect(sourceFiles).toContain(path.join('packages', 'gcp', 'apps.ts'));
	});

	it.each(literals)('has %j only in defaults.ts', function(literal) {
		const files = sourceFiles.filter(function(file) {
			return(literalsOf(fs.readFileSync(path.join(SOURCE_DIRECTORY, file), 'utf8')).includes(literal));
		});

		expect(files).toEqual([]);
	});
});
