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
 * What a profile stands for, with the names of the arguments of
 * `CloudRunService`, so a caller can spread them (`{ ...profiles.production.small }`).
 * Leave `kv` out of a spread unless the app has a key-value store (it only
 * gives `kv.memorySizeGb`, and `kv` adds a store), and leave `vpc` out when
 * the app has a `network`.
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
	kv: { memorySizeGb: number };
}

/** Merges the two axes into the values of the profile. Pure: every call returns new objects. */
export function resolveProfile(profile: DeploymentProfile): ProfileValues {
	const environment = PROFILE_PRESETS.environment[profile.environment].database;
	const size = PROFILE_PRESETS.size[profile.size];

	const values: ProfileValues = {
		database: {
			tier: size.database.tier,
			flags: { ...size.database.flags },
			poolSize: size.database.poolSize,
			deletionProtection: environment.deletionProtection,
			queryInsights: environment.queryInsights
		},
		service: { ...size.service },
		worker: { ...size.worker },
		vpc: { connector: { ...size.vpc.connector }},
		kv: { ...size.kv }
	};

	if (environment.backups !== undefined) {
		values.database.backups = {
			pointInTimeRecovery: environment.backups.pointInTimeRecovery,
			retentionSettings: { ...environment.backups.retentionSettings }
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
