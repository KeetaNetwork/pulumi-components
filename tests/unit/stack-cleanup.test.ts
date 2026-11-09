import { describe, expect, it } from 'vitest';

import { selectStacksToClean } from '../helpers/pulumi';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const MINUTE = 60_000;
const MAX_AGE_MS = 150 * MINUTE;

function stack(name: string, lastUpdateMinutesAgo?: number) {
	return({
		name,
		current: false,
		...(lastUpdateMinutesAgo === undefined ? {} : { lastUpdate: new Date(NOW - lastUpdateMinutesAgo * MINUTE).toISOString() })
	});
}

function select(stacks: ReturnType<typeof stack>[], runId: string | undefined) {
	return(selectStacksToClean(stacks, { runId, maxAgeMs: MAX_AGE_MS, now: NOW }).map(function(entry) {
		return(entry.name);
	}));
}

describe('selectStacksToClean', function() {
	it('selects every stack of the current run, however recent', function() {
		const recent = `ci-42-sw-${NOW - MINUTE}`;
		const otherRun = `ci-43-sw-${NOW - MINUTE}`;

		expect(select([stack(recent, 1), stack(otherRun, 1)], '42')).toEqual([recent]);
	});

	it('does not match a run whose id merely starts with the current one', function() {
		expect(select([stack(`ci-420-sw-${NOW - MINUTE}`, 1)], '42')).toEqual([]);
	});

	it('selects test stacks untouched for longer than the maximum age', function() {
		const stale = `ci-41-db-${NOW - 300 * MINUTE}`;
		const legacy = `test-${NOW - 300 * MINUTE}`;
		const live = `ci-43-fs-${NOW - 200 * MINUTE}`;

		expect(select([stack(stale, 290), stack(legacy, 290), stack(live, 10)], '42')).toEqual([stale, legacy]);
	});

	it('ages a never-updated stack by the creation time in its name', function() {
		const killedFirstUpdate = `ci-41-db-${NOW - 300 * MINUTE}`;
		const starting = `ci-43-db-${NOW - 5 * MINUTE}`;

		expect(select([stack(killedFirstUpdate), stack(starting)], undefined)).toEqual([killedFirstUpdate]);
	});

	it('never selects a stack that is not a test stack, or whose age is unknown', function() {
		expect(select([stack('dev', 10_000), stack('ci-local-sw')], undefined)).toEqual([]);
	});
});
