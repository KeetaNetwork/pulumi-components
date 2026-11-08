import { expect } from 'vitest';
import { expectArray, expectRecord } from './narrow';

/** Checks that the example service reports a database connection and every injected database env var */
export async function expectHealthyDatabaseService(healthUrl: string): Promise<void> {
	const response = await fetch(healthUrl);
	const body = await response.text();
	expect(response.ok, `HTTP ${response.status}: ${body}`).toBe(true);

	const data = expectRecord(JSON.parse(body), 'health response');
	expect(data.status).toBe('ok');
	expect(data.database).toBeDefined();

	/* "set" means the env var was injected */
	const env = expectRecord(data.env, 'health response env');
	for (const name of [ 'user', 'password', 'database', 'host', 'port' ]) {
		expect(env[name], `env ${name}`).toBe('set');
	}
}

/** Checks that the example service's migrations ran, by reading the test_migrations table */
export async function expectMigrationsApplied(migrationsUrl: string): Promise<void> {
	const response = await fetch(migrationsUrl);
	const body = await response.text();
	expect(response.ok, `Migrations HTTP ${response.status}: ${body}`).toBe(true);

	const data = expectRecord(JSON.parse(body), 'migrations response');
	const rows = expectArray(data.rows, 'migrations rows');
	expect(data.status).toBe('ok');
	expect(data.count).toBeGreaterThan(0);
	expect(rows.length).toBeGreaterThan(0);
	expect(expectRecord(rows[0], 'first migrations row').name).toMatch(/^migration-/);
}
