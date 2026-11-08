import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { expectRecord } from '../../helpers/narrow';
import type { UnknownRecord } from '../../helpers/narrow';
import { captureTree, urnsOf } from './pulumi-tree';
import { TREE_CASES } from './tree-cases';

const baselineDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../urn-baselines');

function readBaseline(file: string, version: string): { version: string, cases: { [caseName: string]: unknown } } {
	if (!fs.existsSync(file)) {
		return({ version, cases: {} });
	}

	const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
	const baseline = expectRecord(parsed, `the baseline ${file}`);
	const cases: UnknownRecord = expectRecord(baseline.cases, `the cases of ${file}`);

	return({ version, cases: { ...cases } });
}

/**
 * Adds the URNs of the named cases to the baseline file of a released
 * version. It only adds: a case that is already in the file is an error, so
 * a frozen entry is never rewritten. Run it (through `make urn-baseline`) on
 * a checkout of the release's `src`, with the new case already appended to
 * `tree-cases.ts`; computed against changed code it would match trivially.
 * The caller must have isolated HOME (`useIsolatedHome`).
 */
export async function writeBaselineCases(version: string, caseNames: string[]): Promise<void> {
	const file = path.join(baselineDirectory, `${version}.json`);
	const baseline = readBaseline(file, version);

	for (const caseName of caseNames) {
		const treeCase = TREE_CASES.find(function(candidate) {
			return(candidate.name === caseName);
		});
		if (treeCase === undefined) {
			throw(new Error(`No case named ${caseName} in tree-cases.ts`));
		}

		if (caseName in baseline.cases) {
			throw(new Error(`Case ${caseName} is already in ${file}; a recorded baseline is never rewritten`));
		}

		/* One at a time: the Pulumi runtime state is process-wide */
		baseline.cases[caseName] = urnsOf(await captureTree(treeCase.build));
	}

	fs.mkdirSync(baselineDirectory, { recursive: true });
	fs.writeFileSync(file, JSON.stringify(baseline, null, '\t') + '\n');
}
