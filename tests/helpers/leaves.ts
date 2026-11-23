import { optionalRecord } from './narrow';

function collectLeaves(value: unknown, leaves: unknown[]) {
	if (Array.isArray(value)) {
		for (const item of value) {
			collectLeaves(item, leaves);
		}

		return;
	}

	/* A class instance (a Pulumi Output, for one) is a value, not a structure to walk */
	const record = optionalRecord(value);
	if (record !== undefined && Object.getPrototypeOf(record) === Object.prototype) {
		for (const item of Object.values(record)) {
			collectLeaves(item, leaves);
		}

		return;
	}

	leaves.push(value);
}

/** Every number, string and other plain value inside the plain objects and arrays of `value` */
export function leavesOf(value: unknown): unknown[] {
	const leaves: unknown[] = [];
	collectLeaves(value, leaves);

	return(leaves);
}

/** True when the value and everything inside it is frozen */
export function isDeeplyFrozen(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) {
		return(true);
	}

	if (!Object.isFrozen(value)) {
		return(false);
	}

	return(Object.values(value).every(isDeeplyFrozen));
}
