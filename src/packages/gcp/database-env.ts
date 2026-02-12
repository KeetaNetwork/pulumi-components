import * as pulumi from '@pulumi/pulumi';
import type { EnvironmentVariables } from './cloudrun';

interface DatabaseConnectionInfo {
	host: pulumi.Input<string>;
	username: pulumi.Input<string>;
	password: pulumi.Input<string>;
	databaseName: pulumi.Input<string>;
	caCertificate: pulumi.Input<string>;
}

/**
 * Build the standard MC_PSQL_DB_* environment variables for database connectivity.
 * Used by CloudRunService, MigrationJob, and ContainerMIG to ensure all three
 * execution contexts connect to the database the same way.
 */
export function buildDatabaseEnvVars(db: DatabaseConnectionInfo): EnvironmentVariables {
	return({
		MC_PSQL_DB_USER: db.username,
		MC_PSQL_DB_PASSWORD: { value: db.password, secret: true },
		MC_PSQL_DB_NAME: db.databaseName,
		MC_PSQL_DB_HOST: db.host,
		MC_PSQL_DB_PORT: '5432',
		MC_PSQL_DB_SSLMODE: 'require',
		MC_PSQL_DB_CA_CERT: db.caCertificate,
		MC_PSQL_DB_URL: {
			value: pulumi.interpolate`postgresql://${db.username}:${db.password}@${db.host}:5432/${db.databaseName}?sslmode=require`,
			secret: true
		}
	});
}
