export interface UnknownRecord {
	[key: string]: unknown;
}

function isRecord(value: unknown): value is UnknownRecord {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

/** Narrows a parsed JSON or Pulumi output value, naming it in the error when it does not fit */
export function expectRecord(value: unknown, description: string): UnknownRecord {
	if (!isRecord(value)) {
		throw(new TypeError(`Expected ${description} to be an object`));
	}

	return(value);
}

export function expectArray(value: unknown, description: string): unknown[] {
	if (!Array.isArray(value)) {
		throw(new TypeError(`Expected ${description} to be an array`));
	}

	return(value);
}

export function expectString(value: unknown, description: string): string {
	if (typeof value !== 'string') {
		throw(new TypeError(`Expected ${description} to be a string`));
	}

	return(value);
}

export function expectBoolean(value: unknown, description: string): boolean {
	if (typeof value !== 'boolean') {
		throw(new TypeError(`Expected ${description} to be a boolean`));
	}

	return(value);
}

export function expectStringArray(value: unknown, description: string): string[] {
	return(expectArray(value, description).map(function(item) {
		return(expectString(item, `an item of ${description}`));
	}));
}

export function expectDefined<Value>(value: Value | undefined, description: string): Value {
	if (value === undefined) {
		throw(new Error(`Expected ${description} to be defined`));
	}

	return(value);
}

/** Narrows to a record without throwing, for values that may legitimately be something else */
export function optionalRecord(value: unknown): UnknownRecord | undefined {
	if (isRecord(value)) {
		return(value);
	}

	return(undefined);
}

/** Follows a path of keys and indexes, giving `undefined` where the value has no such step */
export function valueAt(value: unknown, steps: (string | number)[]): unknown {
	let current = value;
	for (const step of steps) {
		if (typeof step === 'number') {
			if (!Array.isArray(current)) {
				return(undefined);
			}
			current = current[step];
		} else {
			const record = optionalRecord(current);
			if (record === undefined) {
				return(undefined);
			}
			current = record[step];
		}
	}

	return(current);
}

/** Like `valueAt`, but names the path in the error when the value is not there */
export function expectAt(value: unknown, steps: (string | number)[], description: string): unknown {
	const found = valueAt(value, steps);
	if (found === undefined) {
		throw(new Error(`Expected ${description} to have ${steps.join('.')}`));
	}

	return(found);
}
