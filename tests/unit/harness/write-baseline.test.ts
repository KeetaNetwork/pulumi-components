import { describe, it } from 'vitest';

import { useIsolatedHome } from './pulumi-tree';
import { writeBaselineCases } from './write-baseline';

/*
 * The entry point of `make urn-baseline`. It does nothing in a normal test
 * run: it only works when the Makefile names a version and the cases to add.
 */
const version = process.env.URN_BASELINE_VERSION ?? '';
const caseNames = (process.env.URN_BASELINE_CASES ?? '').split(',').filter(function(caseName) {
	return(caseName !== '');
});

describe('URN baseline writer', function() {
	useIsolatedHome();

	it.skipIf(version === '' || caseNames.length === 0)('adds the named cases to the baseline of the version', async function() {
		await writeBaselineCases(version, caseNames);
	});
});
