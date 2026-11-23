import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { useTempDirectories } from '../helpers/temp-directories';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/packages/gcp/client-auth.ts');

/*
 * A consumer program has one `google-auth-library` at the top of its
 * node_modules, and each Google Cloud client has its own `google-gax`, which
 * can bring another version nested under it (examples/fullstack-app has 9.x
 * at the top and 10.x under google-gax). Version 9 gives the headers of a
 * request as an object, version 10 as a `Headers`, and gax 5 calls `forEach`
 * on them. The libraries below are the two shapes, and the client is the
 * smallest thing that calls the way gax does. The compiled client-auth.ts
 * runs in this layout the way it runs in the program of a consumer.
 */
function authLibrary(version: string, headersOf: (source: string) => string) {
	return(`
exports.version = ${JSON.stringify(version)};
class Credentials {
	constructor(source) {
		this.source = source;
	}
	async getRequestHeaders() {
		return(${headersOf('this.source')});
	}
}
class GoogleAuth {
	constructor(options) {
		this.options = options;
		this.library = exports.version;
	}
	async getClient() {
		return(this.options?.authClient ?? new Credentials(this.library));
	}
}
class Impersonated {
	constructor(options) {
		this.options = options;
		this.library = exports.version;
	}
	async getRequestHeaders() {
		await this.options.sourceClient.getRequestHeaders();
		return(${headersOf('this.library')});
	}
}
exports.GoogleAuth = GoogleAuth;
exports.Impersonated = Impersonated;
`);
}

function headersV9(source: string) {
	return(`{ via: ${source} }`);
}

function headersV10(source: string) {
	return(`new Headers({ via: ${source} })`);
}

function fakePackage(name: string, main: string) {
	return({
		[`${name}/package.json`]: JSON.stringify({ name: path.basename(name), version: '1.0.0', main: 'index.js' }),
		[`${name}/index.js`]: main
	});
}

const CLIENT = `
const gax = require('google-gax');
exports.CloudBuildClient = class CloudBuildClient {
	constructor(options = {}) {
		this.auth = options.auth ?? new gax.GoogleAuth(options);
	}
	/* What gax 5 does with the credentials of a call */
	async call() {
		const credentials = await this.auth.getClient();
		const headers = await credentials.getRequestHeaders();
		let via;
		headers.forEach(function(value) {
			via = value;
		});

		return(via);
	}
};
`;

const GAX = `
exports.googleAuthLibrary = require('google-auth-library');
exports.GoogleAuth = exports.googleAuthLibrary.GoogleAuth;
`;

const SCRIPT = `
const { googleAuthForClient } = require('./client-auth.js');
const { CloudBuildClient } = require('@google-cloud/cloudbuild');

async function main() {
	const plain = new CloudBuildClient({ projectId: 'project-id', auth: await googleAuthForClient('@google-cloud/cloudbuild', { project: 'project-id' }) });

	const impersonating = new CloudBuildClient({ projectId: 'project-id', auth: await googleAuthForClient('@google-cloud/cloudbuild', { project: 'project-id', impersonateServiceAccount: 'deployer@project-id.iam.gserviceaccount.com' }) });

	console.log(JSON.stringify({ plain: await plain.call(), impersonating: await impersonating.call() }));
}

main().catch(function(error) {
	console.error(error);
	process.exit(1);
});
`;

function compiled() {
	const output = ts.transpileModule(fs.readFileSync(SOURCE, 'utf8'), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
	});

	return(output.outputText);
}

describe('googleAuthForClient in the layout of a consumer', function() {
	const directories = useTempDirectories();

	function run(topLevelHeaders: (source: string) => string) {
		const directory = directories.make({
			'run.js': SCRIPT,
			'client-auth.js': compiled(),
			...fakePackage('node_modules/google-auth-library', authLibrary('top-level', topLevelHeaders)),
			...fakePackage('node_modules/@pulumi/pulumi', 'exports.output = function(value) { return(value); };'),
			...fakePackage('node_modules/@pulumi/gcp', 'exports.Provider = class Provider {};'),
			...fakePackage('node_modules/@google-cloud/cloudbuild', CLIENT),
			...fakePackage('node_modules/@google-cloud/cloudbuild/node_modules/google-gax', GAX),
			...fakePackage('node_modules/@google-cloud/cloudbuild/node_modules/google-gax/node_modules/google-auth-library', authLibrary('of-gax', headersV10))
		});

		return(spawnSync(process.execPath, [ path.join(directory, 'run.js') ], { cwd: directory, env: {}, encoding: 'utf8' }));
	}

	it.each([
		[ 'an object (version 9)', headersV9 ],
		[ 'a Headers (version 10)', headersV10 ]
	])('calls as the account with the library of the client when the top-level one gives its headers as %s', function(_description, topLevelHeaders) {
		const result = run(topLevelHeaders);

		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		/* The plain client is left to find its own credentials, and the impersonated one is made of the library of the client */
		expect(JSON.parse(result.stdout)).toEqual({ plain: 'of-gax', impersonating: 'of-gax' });
	});
});
