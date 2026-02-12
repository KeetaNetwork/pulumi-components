import { Pool } from 'pg';

const pool = new Pool({
	user: process.env.MC_PSQL_DB_USER,
	password: process.env.MC_PSQL_DB_PASSWORD,
	database: process.env.MC_PSQL_DB_NAME,
	host: process.env.MC_PSQL_DB_HOST,
	port: parseInt(process.env.MC_PSQL_DB_PORT ?? '5432', 10),
	ssl: process.env.MC_PSQL_DB_CA_CERT
		? { ca: process.env.MC_PSQL_DB_CA_CERT, checkServerIdentity: () => undefined }
		: false
});

async function migrate() {
	console.log('Running migration...');

	await pool.query(`
		CREATE TABLE IF NOT EXISTS test_migrations (
			id serial PRIMARY KEY,
			name text,
			created_at timestamp DEFAULT now()
		)
	`);

	await pool.query(
		`INSERT INTO test_migrations (name) VALUES ($1)`,
		[`migration-${Date.now()}`]
	);

	console.log('Migration complete');
	await pool.end();
}

migrate().catch(function(err) {
	console.error('Migration failed:', err);
	process.exit(1);
});
