import { CLOUD_SQL_CONNECTION_DEFAULTS } from './defaults';

const CUSTOM_TIER = /^db-custom-(\d+)-(\d+)$/;
const PERF_OPTIMIZED_TIER = /^db-perf-optimized-N-\d+$/;

/** A Cloud SQL tier, read once: what its name says about how many connections it allows */
export type TierShape = {
	kind: 'shared';
	name: string;
} | {
	kind: 'custom';
	cpus: number;
	memoryMb: number;
} | {
	/** A tier of the Enterprise Plus edition (`db-perf-optimized-N-<cpus>`): the library has no table of connections for it */
	kind: 'perf-optimized';
	tier: string;
} | {
	/** A tier that this library has no table for (the budget of it needs an explicit `max_connections`) */
	kind: 'unknown';
	tier: string;
};

/** The connections of a database: all of them, the ones kept back, and the ones the applications share */
export interface ConnectionBudget {
	maxConnections: number;
	reserve: number;
	available: number;
}

/** One application that opens connections: each of its instances holds a pool */
export interface ConnectionConsumer {
	name: string;
	maxInstances: number;
	poolSize: number;
}

/** Thrown when the pools of the consumers need more connections than the database has to share */
export class ConnectionBudgetExceededError extends Error {
	readonly total: number;
	readonly available: number;

	constructor(message: string, total: number, available: number) {
		super(message);
		this.name = 'ConnectionBudgetExceededError';
		this.total = total;
		this.available = available;
	}
}

/** Thrown when `maxConnections` and `flags.max_connections` both say how many connections there are */
export class MaxConnectionsConflictError extends Error {
	constructor() {
		super('maxConnections and flags.max_connections both set max_connections, give one of them');
		this.name = 'MaxConnectionsConflictError';
	}
}

/** What sets the `max_connections` of a database: the flag, `maxConnections`, or neither (the tier decides) */
export interface MaxConnectionsSource {
	flags?: { max_connections?: number };
	maxConnections?: number | 'tier-default';
}

/** Reads the name of a tier. Never throws: a tier that is not known is a shape, and only a default asked of it fails. */
export function parseCloudSqlTier(tier: string): TierShape {
	const shared = CLOUD_SQL_CONNECTION_DEFAULTS.shared.find(function(entry) {
		return(entry.tier === tier);
	});
	if (shared !== undefined) {
		return({ kind: 'shared', name: shared.tier });
	}

	const custom = CUSTOM_TIER.exec(tier);
	if (custom?.[1] !== undefined && custom[2] !== undefined) {
		return({ kind: 'custom', cpus: Number(custom[1]), memoryMb: Number(custom[2]) });
	}

	if (PERF_OPTIMIZED_TIER.test(tier)) {
		return({ kind: 'perf-optimized', tier });
	}

	return({ kind: 'unknown', tier });
}

/** Whether the library knows the default `max_connections` of this kind of tier (`shared` and `custom` tiers) */
export function knowsMaxConnections(shape: TierShape): shape is Extract<TierShape, { kind: 'shared' | 'custom' }> {
	return(shape.kind === 'shared' || shape.kind === 'custom');
}

/**
 * The `max_connections` that Cloud SQL applies to a tier when no flag sets it
 *
 * @throws Error naming the tier when the tier is not one that this library knows
 */
export function tierDefaultMaxConnections(shape: TierShape): number {
	if (!knowsMaxConnections(shape)) {
		throw(new Error(`The default max_connections of the Cloud SQL tier '${shape.tier}' is not known: set max_connections (flags.max_connections or maxConnections) to give the connection budget a value`));
	}

	if (shape.kind === 'shared') {
		const entry = CLOUD_SQL_CONNECTION_DEFAULTS.shared.find(function(candidate) {
			return(candidate.tier === shape.name);
		});
		if (entry === undefined) {
			throw(new Error(`The default max_connections of the Cloud SQL tier '${shape.name}' is not known`));
		}

		return(entry.maxConnections);
	}

	let connections: number = CLOUD_SQL_CONNECTION_DEFAULTS.customBands[0].maxConnections;
	for (const band of CLOUD_SQL_CONNECTION_DEFAULTS.customBands) {
		if (shape.memoryMb >= band.fromMemoryMb) {
			connections = band.maxConnections;
		}
	}

	return(connections);
}

/**
 * Checks that `maxConnections` and `flags.max_connections` are not both given
 * (a flag that is `undefined` is not given)
 *
 * @throws MaxConnectionsConflictError when they are
 */
export function assertMaxConnectionsUnambiguous(source: MaxConnectionsSource): void {
	if (source.flags?.max_connections !== undefined && source.maxConnections !== undefined) {
		throw(new MaxConnectionsConflictError());
	}
}

/**
 * The one resolver of `max_connections`: the flag, else a number in
 * `maxConnections`, else the default of the tier. The budget of
 * `PostgresCloudSQL` and the check of `CloudRunService` both read it.
 *
 * @throws MaxConnectionsConflictError when the flag and `maxConnections` are both given
 * @throws Error naming the tier when neither is given and the tier is not one that the library knows
 */
export function resolveMaxConnections(source: MaxConnectionsSource & { tier: string }): number {
	assertMaxConnectionsUnambiguous(source);

	const flag = source.flags?.max_connections;
	if (flag !== undefined) {
		return(flag);
	}

	if (typeof source.maxConnections === 'number') {
		return(source.maxConnections);
	}

	return(tierDefaultMaxConnections(parseCloudSqlTier(source.tier)));
}

/**
 * Splits `maxConnections` into the reserve (whole connections, rounded up so
 * that it is never below its share) and what is available to share
 */
export function connectionBudget(input: { maxConnections: number; reserveFraction?: number }): ConnectionBudget {
	const { maxConnections } = input;
	const reserveFraction = input.reserveFraction ?? CLOUD_SQL_CONNECTION_DEFAULTS.reserveFraction;

	if (!Number.isInteger(maxConnections) || maxConnections < 0) {
		throw(new Error(`max_connections must be a whole number of connections, 0 or more (got ${maxConnections})`));
	}

	if (!(reserveFraction >= 0 && reserveFraction <= 1)) {
		throw(new Error(`The reserve of the connection budget must be a fraction from 0 to 1 (got ${reserveFraction})`));
	}

	/* Rounded to nine places first, so that a product such as 120 * 0.1 is not pushed over a whole number by floating point */
	const reserve = Math.ceil(Number((maxConnections * reserveFraction).toFixed(9)));

	return({ maxConnections, reserve, available: maxConnections - reserve });
}

/**
 * Checks that every consumer can hold its pools at once: the sum of
 * `maxInstances * poolSize` must not pass what is available.
 *
 * @throws ConnectionBudgetExceededError listing the share of each consumer
 */
export function assertWithinBudget(budget: ConnectionBudget, consumers: ConnectionConsumer[]): void {
	const shares = consumers.map(function(consumer) {
		return({ name: consumer.name, maxInstances: consumer.maxInstances, poolSize: consumer.poolSize, connections: consumer.maxInstances * consumer.poolSize });
	});
	const total = shares.reduce(function(sum, share) {
		return(sum + share.connections);
	}, 0);

	if (total <= budget.available) {
		return;
	}

	const lines = shares.map(function(share) {
		return(`${share.name}: ${share.maxInstances} instances x pool of ${share.poolSize} = ${share.connections}`);
	});

	throw(new ConnectionBudgetExceededError(
		`The connection pools need ${total} connections but ${budget.available} are available (max_connections ${budget.maxConnections}, ${budget.reserve} kept in reserve): ${lines.join('; ')}. Lower a pool size or a maximum number of instances, or raise max_connections`,
		total,
		budget.available
	));
}
