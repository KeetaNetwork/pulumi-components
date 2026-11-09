import { PROFILE_PRESETS } from './defaults';

export type ProfileEnvironment = keyof typeof PROFILE_PRESETS.environment;
export type ProfileSize = keyof typeof PROFILE_PRESETS.size;

/**
 * The two choices that a profile is made of. They are independent: a test
 * deployment may be large (a load test), and a small production app still
 * has deletion protection and backups.
 */
export interface DeploymentProfile {
	/** Safety and visibility: deletion protection, backups, query insights */
	environment: ProfileEnvironment;

	/** Capacity: database tier and connections, instances and pool sizes, connector, Redis */
	size: ProfileSize;
}

/**
 * What a profile stands for. The fields mirror the arguments of
 * `CloudRunService`, so a caller can spread them (`{ ...profiles.production.small }`),
 * except `kvMemorySizeGb`, which is the value for `kv.memorySizeGb` of an app
 * that has a key-value store (a spread cannot make one).
 */
export interface ProfileValues {
	database: {
		tier: string;
		flags: { max_connections: number };
		poolSize: number;
		deletionProtection: boolean;
		queryInsights: boolean;

		/** Left out for an environment that does not back up */
		backups?: {
			pointInTimeRecovery: boolean;
			retentionSettings: {
				retainCount: number;
				transactionLogRetentionDays?: number;
			};
		};
	};
	service: { maxInstances: number };
	worker: { poolSize: number };
	vpc: { connector: { minInstances: number; maxInstances: number }};
	kvMemorySizeGb: number;
}

/** Merges the two axes into the values of the profile. Pure: every call returns new objects. */
export function resolveProfile(profile: DeploymentProfile): ProfileValues {
	const environment = PROFILE_PRESETS.environment[profile.environment];
	const size = PROFILE_PRESETS.size[profile.size];

	const values: ProfileValues = {
		database: {
			tier: size.tier,
			flags: { max_connections: size.maxConnections },
			poolSize: size.servicePoolSize,
			deletionProtection: environment.deletionProtection,
			queryInsights: environment.queryInsights
		},
		service: { maxInstances: size.maxInstances },
		worker: { poolSize: size.workerPoolSize },
		vpc: { connector: { ...size.connector }},
		kvMemorySizeGb: size.redisMemorySizeGb
	};

	if (environment.backups !== undefined) {
		values.database.backups = {
			pointInTimeRecovery: environment.backups.pointInTimeRecovery,
			retentionSettings: {
				retainCount: environment.backups.retainCount,
				transactionLogRetentionDays: environment.backups.transactionLogRetentionDays
			}
		};
	}

	return(values);
}

function sizesOf(environment: ProfileEnvironment): { [size in ProfileSize]: ProfileValues } {
	return({
		small: resolveProfile({ environment, size: 'small' }),
		medium: resolveProfile({ environment, size: 'medium' }),
		large: resolveProfile({ environment, size: 'large' })
	});
}

/** The values of every profile, to spread into the arguments: `profiles[environment][size]` equals `resolveProfile({ environment, size })` */
export const profiles: { [environment in ProfileEnvironment]: { [size in ProfileSize]: ProfileValues }} = {
	development: sizesOf('development'),
	test: sizesOf('test'),
	production: sizesOf('production')
};
