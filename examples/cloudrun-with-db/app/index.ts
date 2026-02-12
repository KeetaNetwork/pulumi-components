import * as http from 'http';
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

const PORT = process.env.PORT ?? 8080;

interface HealthResponse {
	status: 'ok' | 'error';
	database?: string;
	timestamp?: string;
	message?: string;
	env: {
		user: 'set' | 'missing';
		password: 'set' | 'missing';
		database: 'set' | 'missing';
		host: 'set' | 'missing';
		port: 'set' | 'missing';
	};
}

interface MigrationRow {
	id: number;
	name: string;
	created_at: string;
}

interface MigrationsResponse {
	status: 'ok' | 'error';
	count?: number;
	rows?: MigrationRow[];
	message?: string;
}

function getEnvStatus(): HealthResponse['env'] {
	return {
		user: process.env.MC_PSQL_DB_USER ? 'set' : 'missing',
		password: process.env.MC_PSQL_DB_PASSWORD ? 'set' : 'missing',
		database: process.env.MC_PSQL_DB_NAME ? 'set' : 'missing',
		host: process.env.MC_PSQL_DB_HOST ? 'set' : 'missing',
		port: process.env.MC_PSQL_DB_PORT ? 'set' : 'missing'
	};
}

const server = http.createServer(async function(req, res) {
	if (req.url === '/health' || req.url === '/') {
		try {
			const result = await pool.query('SELECT NOW() as time, current_database() as db');
			const response: HealthResponse = {
				status: 'ok',
				database: result.rows[0].db,
				timestamp: result.rows[0].time,
				env: getEnvStatus()
			};
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(response));
		} catch (err) {
			const response: HealthResponse = {
				status: 'error',
				message: err instanceof Error ? err.message : String(err),
				env: getEnvStatus()
			};
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(response));
		}
	} else if (req.url === '/migrations') {
		try {
			const result = await pool.query<MigrationRow>('SELECT * FROM test_migrations ORDER BY created_at DESC');
			const response: MigrationsResponse = {
				status: 'ok',
				count: result.rowCount ?? 0,
				rows: result.rows
			};
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(response));
		} catch (err) {
			const response: MigrationsResponse = {
				status: 'error',
				message: err instanceof Error ? err.message : String(err)
			};
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(response));
		}
	} else {
		res.writeHead(404);
		res.end('Not Found');
	}
});

server.listen(PORT, function() {
	console.log(`Server running on port ${PORT}`);
});
