import { describe, expect, it } from 'vitest';

import { addSubjectAlternativeToHosts } from '../../src/hosts';

/*
 * Programs import this function from `@keetanetwork/pulumi-components/hosts.js`
 * when they start, so the module is part of the published API even though the
 * package root does not export it.
 */
describe('the hosts module', function() {
	it('exports addSubjectAlternativeToHosts', function() {
		expect(addSubjectAlternativeToHosts).toBeTypeOf('function');
	});
});
