import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { useTempDirectories } from '../helpers/temp-directories';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GCP_SOURCES = path.join(ROOT, 'src/packages/gcp');
const PACKAGE = 'node_modules/@keetanetwork/pulumi-components';

/*
 * The engine runs a dynamic provider in a host process started from the
 * program's own @pulumi/pulumi, and loads the serialized provider there. A
 * `require` in the provider's code resolves from the top of the program's
 * node_modules, but a consumer's package manager can leave the Google Cloud
 * clients nested under this package (keeta-production after its packages
 * deduped onto one pulumi-components). The layout below has the clients only
 * under the package, serializes each provider the way pulumi.dynamic.Resource
 * does, and runs it from the top of the program the way the host does.
 */
function compiled(file: string) {
	const output = ts.transpileModule(fs.readFileSync(path.join(GCP_SOURCES, file), 'utf8'), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
	});

	return(output.outputText);
}

function fakePackage(name: string, main: string) {
	return({
		[`${name}/package.json`]: JSON.stringify({ name: name.split('node_modules/').pop(), version: '1.0.0', main: 'index.js' }),
		[`${name}/index.js`]: `Object.defineProperty(exports, '__esModule', { value: true });\n${main}`
	});
}

const AUTH_LIBRARY = `
exports.GoogleAuth = class GoogleAuth {};
exports.Impersonated = class Impersonated {};
`;

const GAX = `
exports.googleAuthLibrary = require('google-auth-library');
`;

/* Each client answers the one call the provider makes with what the real one would */
const CLOUDBUILD = `
exports.CloudBuildClient = class CloudBuildClient {
	async createBuild(request) {
		return([{ promise: async function() {
			return([{ status: 'SUCCESS', results: { images: [{ name: request.build.images[0], digest: 'sha256:0' }] } }]);
		} }]);
	}
};
`;

const SECRET_MANAGER = `
exports.SecretManagerServiceClient = class SecretManagerServiceClient {};
`;

const RUN = `
exports.protos = { google: { cloud: { run: { v2: { Condition: { State: { 4: 'CONDITION_SUCCEEDED' } } } } } } };
exports.JobsClient = class JobsClient {
	async runJob(request) {
		return([{ promise: async function() {
			return([{ name: request.name + '/executions/1', conditions: [{ type: 'Completed', state: 4 }] }]);
		} }]);
	}
};
`;

function nestedClient(name: string, main: string) {
	return({
		...fakePackage(`${PACKAGE}/node_modules/${name}`, main),
		...fakePackage(`${PACKAGE}/node_modules/${name}/node_modules/google-gax`, GAX),
		...fakePackage(`${PACKAGE}/node_modules/${name}/node_modules/google-gax/node_modules/google-auth-library`, AUTH_LIBRARY)
	});
}

/* Serializes the provider, then loads and calls it from the top of the program */
const SCRIPT = `
const fs = require('node:fs');
const { runtime } = require('@pulumi/pulumi');

async function main() {
	const [ moduleName, inputs ] = process.argv.slice(2);
	const { _Testing } = require('@keetanetwork/pulumi-components/' + moduleName);
	const provider = _Testing.provider;
	const serialized = await runtime.serializeFunction(function() {
		return(provider);
	}, { allowSecrets: true });

	fs.writeFileSync('host.js', serialized.text);
	const loaded = require('./host.js').handler();
	const result = await loaded.create(JSON.parse(inputs));

	console.log(JSON.stringify(result.outs));
}

main().catch(function(error) {
	console.error(error);
	process.exit(1);
});
`;

describe('dynamic providers in the layout of a consumer', function() {
	const directories = useTempDirectories();

	function run(moduleName: string, inputs: unknown) {
		const directory = directories.make({
			'run.js': SCRIPT,
			[`${PACKAGE}/package.json`]: JSON.stringify({ name: '@keetanetwork/pulumi-components', version: '1.0.0' }),
			[`${PACKAGE}/client-auth.js`]: compiled('client-auth.ts'),
			[`${PACKAGE}/cloudbuild.js`]: compiled('cloudbuild.ts'),
			[`${PACKAGE}/cloudrun-job.js`]: compiled('cloudrun-job.ts'),
			...fakePackage('node_modules/google-auth-library', AUTH_LIBRARY),
			...fakePackage('node_modules/@pulumi/gcp', 'exports.Provider = class Provider {};'),
			...nestedClient('@google-cloud/cloudbuild', CLOUDBUILD),
			...nestedClient('@google-cloud/secret-manager', SECRET_MANAGER),
			...nestedClient('@google-cloud/run', RUN)
		}, {
			'node_modules/@pulumi/pulumi': path.join(ROOT, 'node_modules/@pulumi/pulumi')
		});

		return(spawnSync(process.execPath, [ '--no-warnings', path.join(directory, 'run.js'), moduleName, JSON.stringify(inputs) ], { cwd: directory, env: {}, encoding: 'utf8' }));
	}

	it('runs a Cloud Build with the clients nested under this package', function() {
		const build = { images: [ 'us-docker.pkg.dev/project/repo/image:hash_abc' ] };
		const result = run('cloudbuild.js', { build, projectId: 'project' });

		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ status: 'SUCCESS', results: { images: [{ name: build.images[0], digest: 'sha256:0' }] }});
	});

	it('runs a Cloud Run job with the client nested under this package', function() {
		const result = run('cloudrun-job.js', { jobName: 'job', projectId: 'project', region: 'us-west2', trigger: '1' });

		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ executionName: 'projects/project/locations/us-west2/jobs/job/executions/1', status: 'CONDITION_SUCCEEDED' });
	});
});
