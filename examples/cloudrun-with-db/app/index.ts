import * as http from 'http';
import { Pool } from 'pg';

const pool = new Pool({
	user: process.env.MC_CRED_USER,
	password: process.env.MC_CRED_PASSWORD,
	database: process.env.MC_CRED_DATABASE,
	host: process.env.MC_CRED_HOST,
	port: parseInt(process.env.MC_CRED_PORT ?? '5432', 10)
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

function getEnvStatus(): HealthResponse['env'] {
	return {
		user: process.env.MC_CRED_USER ? 'set' : 'missing',
		password: process.env.MC_CRED_PASSWORD ? 'set' : 'missing',
		database: process.env.MC_CRED_DATABASE ? 'set' : 'missing',
		host: process.env.MC_CRED_HOST ? 'set' : 'missing',
		port: process.env.MC_CRED_PORT ? 'set' : 'missing'
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
	} else {
		res.writeHead(404);
		res.end('Not Found');
	}
});

server.listen(PORT, function() {
	console.log(`Server running on port ${PORT}`);
});
