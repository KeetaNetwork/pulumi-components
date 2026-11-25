import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as apps from '../../src/packages/gcp/apps';
import type * as bucket from '../../src/packages/gcp/bucket';
import type * as core from '../../src/packages/gcp/bucket-sync-core';
import type * as script from '../../src/packages/gcp/bucket-sync-script';
import type { BucketSyncFile, BucketSyncManifest, BucketSyncRemoteObject, BucketSyncStore } from '../../src/packages/gcp/bucket-sync-core';
import { expectRecord } from '../helpers/narrow';
import { useTempDirectories } from '../helpers/temp-directories';
import { requireSource } from './harness/load-sources';
import { captureTree, ofType, useIsolatedHome } from './harness/pulumi-tree';
import type { TreeSnapshot } from './harness/pulumi-tree';

const { StaticWebApp, STATIC_WEB_APP_UPLOAD_CONFIG } = requireSource<typeof apps>('src/packages/gcp/apps.ts');
const { BucketSync, buildBucketSyncManifest, contentTypeOf, ensurePrivateDirectory } = requireSource<typeof bucket>('src/packages/gcp/bucket.ts');
const { manifestHash, manifestPath, normalizePrefix, fileOfObject, planSync, syncBucket, describeResult } = requireSource<typeof core>('src/packages/gcp/bucket-sync-core.ts');
const { gcsStore, readManifest } = requireSource<typeof script>('src/packages/gcp/bucket-sync-script.ts');

const STATIC_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/static');

function sha256(contents: string) {
	return(createHash('sha256').update(contents).digest('hex'));
}

function file(name: string, contents: string, extra: Partial<BucketSyncFile> = {}): BucketSyncFile {
	return({ name, sha256: sha256(contents), contentType: 'text/plain', ...extra });
}

function manifestOf(files: BucketSyncFile[], extra: Partial<BucketSyncManifest> = {}): BucketSyncManifest {
	return({ directory: '/unused', bucket: 'site', prefix: '', files, retainPrefixes: [ 'assets/' ], uploadLast: [ 'index.html' ], prune: true, ...extra });
}

function remoteOf(syncFile: BucketSyncFile): BucketSyncRemoteObject {
	return({ name: syncFile.name, sha256: syncFile.sha256, contentType: syncFile.contentType, cacheControl: syncFile.cacheControl });
}

/** A bucket in memory that records every call in order */
function memoryStore(initial: BucketSyncRemoteObject[]) {
	const objects = new Map(initial.map(function(object) {
		return([ object.name, object ] as const);
	}));
	const events: string[] = [];
	const store: BucketSyncStore = {
		list: async function() {
			return([ ...objects.values() ]);
		},
		upload: async function(syncFile) {
			/* A moment of work, so parallel uploads interleave the way real ones do */
			await new Promise(function(resolve) {
				setTimeout(resolve, 1);
			});
			events.push(`upload ${syncFile.name}`);
			objects.set(syncFile.name, remoteOf(syncFile));
		},
		remove: async function(name) {
			events.push(`delete ${name}`);
			objects.delete(name);
		}
	};

	return({ store, events, objects });
}

describe('BucketSync manifest', function() {
	const directories = useTempDirectories();

	it('lists every file with its SHA-256, content type and cache header, sorted, with / separators', function() {
		const directory = directories.make({
			'index.html': '<html></html>',
			'assets/app-1234.js': 'console.log(1);',
			'robots.txt': 'User-agent: *',
			'skip.map': 'skipped'
		});

		const manifest = buildBucketSyncManifest('site', directory, {
			filter: function(name) {
				return(!name.endsWith('.map'));
			},
			computeCacheControl: function(name) {
				return(name === 'index.html' ? 'public, max-age=10' : undefined);
			}
		});

		expect(manifest).toEqual({
			directory,
			bucket: 'site',
			prefix: '',
			files: [
				{ name: 'assets/app-1234.js', sha256: sha256('console.log(1);'), contentType: 'application/javascript' },
				{ name: 'index.html', sha256: sha256('<html></html>'), contentType: 'text/html', cacheControl: 'public, max-age=10' },
				{ name: 'robots.txt', sha256: sha256('User-agent: *'), contentType: 'text/plain' }
			],
			retainPrefixes: [],
			uploadLast: [ 'index.html' ],
			prune: true
		});
	});

	it('gives web files their content types, wasm included', function() {
		expect(Object.fromEntries([ 'a.html', 'a.js', 'a.mjs', 'a.wasm', 'a.webmanifest', 'a.ico', 'a.ttf', 'A.SVG', 'a.unknown', 'apple-app-site-association' ].map(function(name) {
			return([ name, contentTypeOf(name) ]);
		}))).toEqual({
			'a.html': 'text/html',
			'a.js': 'application/javascript',
			'a.mjs': 'application/javascript',
			'a.wasm': 'application/wasm',
			'a.webmanifest': 'application/manifest+json',
			'a.ico': 'image/x-icon',
			'a.ttf': 'font/ttf',
			'A.SVG': 'image/svg+xml',
			'a.unknown': 'application/octet-stream',
			'apple-app-site-association': 'application/octet-stream'
		});
	});

	it('has a hash that follows the contents and the settings, not the directory', function() {
		const first = buildBucketSyncManifest('site', directories.make({ 'index.html': 'a' }), {});
		const moved = buildBucketSyncManifest('site', directories.make({ 'index.html': 'a' }), {});
		const changed = buildBucketSyncManifest('site', directories.make({ 'index.html': 'b' }), {});

		expect(manifestHash(moved)).toBe(manifestHash(first));
		expect(manifestHash(changed)).not.toBe(manifestHash(first));
		expect(manifestHash({ ...first, bucket: 'other' })).not.toBe(manifestHash(first));
		expect(manifestHash({ ...first, prune: false })).not.toBe(manifestHash(first));
		expect(manifestHash({ ...first, retainPrefixes: [ 'assets/' ] })).not.toBe(manifestHash(first));
	});
});

describe('BucketSync plan and sync', function() {
	const index = file('index.html', 'new index', { cacheControl: 'public, max-age=10' });
	const asset = file('assets/new.js', 'new asset');
	const robots = file('robots.txt', 'robots');

	it('uploads retained assets first, then other files, then index.html, then deletes', async function() {
		const { store, events } = memoryStore([
			remoteOf(file('index.html', 'old index')),
			remoteOf(file('assets/old.js', 'old asset')),
			remoteOf(file('stale.txt', 'stale'))
		]);

		const result = await syncBucket(manifestOf([ index, asset, robots ]), store);

		expect(events).toEqual([
			'upload assets/new.js',
			'upload robots.txt',
			'upload index.html',
			'delete stale.txt'
		]);
		expect(result).toEqual({ uploaded: [ 'assets/new.js', 'robots.txt', 'index.html' ], deleted: [ 'stale.txt' ], unchanged: 0, retained: 1 });
	});

	it('keeps index.html behind every other upload when many run in parallel', async function() {
		const assets = Array.from({ length: 40 }, function(_ignore, number) {
			return(file(`assets/${number}.js`, String(number)));
		});
		const { store, events } = memoryStore([]);

		await syncBucket(manifestOf([ index, ...assets, robots ]), store, 8);

		expect(events.at(-1)).toBe('upload index.html');
		expect(events.indexOf('upload robots.txt')).toBeGreaterThan(Math.max(...assets.map(function(assetFile) {
			return(events.indexOf(`upload ${assetFile.name}`));
		})));
	});

	it('uploads nothing when the bucket already matches', async function() {
		const { store, events } = memoryStore([ index, asset, robots ].map(remoteOf));

		const result = await syncBucket(manifestOf([ index, asset, robots ]), store);

		expect(events).toEqual([]);
		expect(result.unchanged).toBe(3);
	});

	it('uploads a file again when only its content type or cache header differs', function() {
		const plan = planSync(manifestOf([ index, robots ]), [
			{ ...remoteOf(index), cacheControl: 'public, max-age=300' },
			{ ...remoteOf(robots), contentType: 'application/octet-stream' }
		]);

		expect(plan.last.map(function(syncFile) {
			return(syncFile.name);
		})).toEqual([ 'index.html' ]);
		expect(plan.stages.flat().map(function(syncFile) {
			return(syncFile.name);
		})).toEqual([ 'robots.txt' ]);
	});

	it('never deletes under a retained prefix, and deletes nothing without prune', function() {
		const remote = [ remoteOf(file('assets/old.js', 'old')), remoteOf(file('old.html', 'old')) ];

		expect(planSync(manifestOf([ index ]), remote).deletes).toEqual([ 'old.html' ]);
		expect(planSync(manifestOf([ index ], { prune: false }), remote).deletes).toEqual([]);
		expect(planSync(manifestOf([ index ], { retainPrefixes: [] }), remote).deletes).toEqual([ 'assets/old.js', 'old.html' ]);
	});

	it('stops with the error of a failed upload and deletes nothing', async function() {
		const { store, events } = memoryStore([ remoteOf(file('stale.txt', 'stale')) ]);
		const failing: BucketSyncStore = {
			...store,
			upload: async function(syncFile) {
				if (syncFile.name === 'robots.txt') {
					throw(new Error('upload failed'));
				}
				await store.upload(syncFile);
			}
		};

		await expect(syncBucket(manifestOf([ index, asset, robots ]), failing)).rejects.toThrow('upload failed');
		expect(events).toEqual([ 'upload assets/new.js' ]);
	});

	it('cuts long lists in its report', function() {
		const uploaded = Array.from({ length: 25 }, function(_ignore, number) {
			return(`assets/${number}.js`);
		});
		const report = describeResult('site', { uploaded, deleted: [], unchanged: 3, retained: 1 }, 20);

		expect(report.split('\n')[0]).toBe('gs://site: 25 uploaded, 3 unchanged, 0 deleted, 1 retained');
		expect(report).toContain('... and 5 more uploaded');
	});
});

describe('BucketSync Cloud Storage calls', function() {
	const directories = useTempDirectories();

	interface Call {
		method: string;
		url: string;
		headers: Headers;
		body?: string;
	}

	function fakeFetch(responses: Response[]) {
		const calls: Call[] = [];
		const fetchFunction: typeof fetch = async function(input, init) {
			const body = init?.body;
			calls.push({
				method: init?.method ?? 'GET',
				url: input instanceof Request ? input.url : input.toString(),
				headers: new Headers(init?.headers),
				body: Buffer.isBuffer(body) ? body.toString('utf8') : undefined
			});
			const response = responses.shift();
			if (response === undefined) {
				throw(new Error('No response left'));
			}

			return(response);
		};

		return({ calls, fetchFunction });
	}

	async function token() {
		return('token');
	}

	it('lists, uploads and deletes only under its prefix, with names relative to it', async function() {
		const directory = directories.make({ 'index.html': '<html></html>' });
		const { calls, fetchFunction } = fakeFetch([
			Response.json({ items: [ { name: 'docs/' }, { name: 'docs/old.html', contentType: 'text/html' }, { name: 'docs/index.html', contentType: 'text/html' } ] }),
			Response.json({}),
			new Response(null, { status: 204 })
		]);
		const store = gcsStore('site', directory, token, fetchFunction, 'docs/');

		expect((await store.list()).map(function(object) {
			return(object.name);
		})).toEqual([ 'old.html', 'index.html' ]);
		await store.upload(file('index.html', '<html></html>', { contentType: 'text/html' }));
		await store.remove('old.html');

		expect(new URL(calls[0].url).searchParams.get('prefix')).toBe('docs/');
		expect(calls[1].body).toContain('"name":"docs/index.html"');
		expect(calls[2].url).toBe('https://storage.googleapis.com/storage/v1/b/site/o/docs%2Fold.html');
	});

	it('normalizes a prefix to no leading and one trailing slash, and puts it in the hash', function() {
		expect([ undefined, '', '/', 'docs', '/docs/', 'a/b' ].map(normalizePrefix)).toEqual([ '', '', '', 'docs/', 'docs/', 'a/b/' ]);
		const manifest = manifestOf([ file('index.html', 'a') ]);
		expect(manifestHash({ ...manifest, prefix: 'docs/' })).not.toBe(manifestHash(manifest));
	});

	it('lists every page of the bucket', async function() {
		const { calls, fetchFunction } = fakeFetch([
			Response.json({ items: [ { name: 'index.html', metadata: { 'keeta-sha256': 'a' }, contentType: 'text/html', cacheControl: 'public, max-age=10' } ], nextPageToken: 'next' }),
			Response.json({ items: [ { name: 'assets/a.js', contentType: 'application/javascript' } ] })
		]);

		const objects = await gcsStore('site', '/unused', token, fetchFunction).list();

		expect(objects).toEqual([
			{ name: 'index.html', sha256: 'a', contentType: 'text/html', cacheControl: 'public, max-age=10' },
			{ name: 'assets/a.js', sha256: undefined, contentType: 'application/javascript', cacheControl: undefined }
		]);
		expect(new URL(calls[1].url).searchParams.get('pageToken')).toBe('next');
		expect(calls[0].headers.get('Authorization')).toBe('Bearer token');
	});

	it('uploads the contents with the content type, cache header and SHA-256 in one multipart request', async function() {
		const directory = directories.make({ 'assets/a.js': 'console.log(1);' });
		const { calls, fetchFunction } = fakeFetch([ Response.json({}) ]);

		await gcsStore('site', directory, token, fetchFunction).upload(file('assets/a.js', 'console.log(1);', { contentType: 'application/javascript', cacheControl: 'public, max-age=86400' }));

		expect(calls[0].method).toBe('POST');
		expect(calls[0].url).toBe('https://storage.googleapis.com/upload/storage/v1/b/site/o?uploadType=multipart');
		expect(calls[0].headers.get('Content-Type')).toMatch(/^multipart\/related; boundary=/);
		expect(calls[0].body).toContain(JSON.stringify({ name: 'assets/a.js', contentType: 'application/javascript', metadata: { 'keeta-sha256': sha256('console.log(1);') }, cacheControl: 'public, max-age=86400' }));
		expect(calls[0].body).toContain('Content-Type: application/javascript\r\n\r\nconsole.log(1);\r\n');
	});

	it('refuses to upload a file that changed after the manifest was built', async function() {
		const directory = directories.make({ 'index.html': 'changed' });
		const { fetchFunction } = fakeFetch([]);

		await expect(gcsStore('site', directory, token, fetchFunction).upload(file('index.html', 'original'))).rejects.toThrow('changed after the program read it');
	});

	it('retries a throttled call and accepts a delete of an object that is already gone', async function() {
		const { calls, fetchFunction } = fakeFetch([ new Response('slow down', { status: 429 }), new Response('', { status: 404 }) ]);

		vi.useFakeTimers();
		try {
			const removed = gcsStore('site', '/unused', token, fetchFunction).remove('assets/a b.js');
			await vi.advanceTimersByTimeAsync(500);
			await removed;
		} finally {
			vi.useRealTimers();
		}

		expect(calls.map(function(call) {
			return(`${call.method} ${call.url}`);
		})).toEqual([
			'DELETE https://storage.googleapis.com/storage/v1/b/site/o/assets%2Fa%20b.js',
			'DELETE https://storage.googleapis.com/storage/v1/b/site/o/assets%2Fa%20b.js'
		]);
	});

	it('fails at once on a call that is refused', async function() {
		const { calls, fetchFunction } = fakeFetch([ new Response('forbidden', { status: 403 }) ]);

		await expect(gcsStore('site', '/unused', token, fetchFunction).remove('index.html')).rejects.toThrow('failed with 403: forbidden');
		expect(calls).toHaveLength(1);
	});

	it('refuses object names outside the directory and hashes that are not hashes', function() {
		expect(fileOfObject('/site', 'assets/a.js')).toBe(path.join('/site', 'assets', 'a.js'));
		for (const name of [ '../secret', 'assets/../../secret', '/etc/passwd', '' ]) {
			expect(function() {
				fileOfObject('/site', name);
			}).toThrow('is not inside the directory');
		}
		expect(function() {
			manifestPath('../../etc/passwd');
		}).toThrow('64 lowercase hex digits');
	});

	it('makes the manifest directory private and refuses one that is not a directory', function() {
		const directory = directories.make({ 'file.txt': 'not a directory' });
		fs.chmodSync(directory, 0o777);
		ensurePrivateDirectory(directory);
		expect(fs.statSync(directory).mode & 0o777).toBe(0o700);

		fs.symlinkSync(directory, `${directory}-link`);
		try {
			expect(function() {
				ensurePrivateDirectory(`${directory}-link`);
			}).toThrow('must be a directory of this user');
		} finally {
			fs.rmSync(`${directory}-link`, { force: true });
		}
	});

	it('reads only the manifest of its hash and bucket', function() {
		const manifest = manifestOf([ file('index.html', 'a') ]);
		const hash = manifestHash(manifest);
		fs.mkdirSync(path.dirname(manifestPath(hash)), { recursive: true });
		fs.writeFileSync(manifestPath(hash), JSON.stringify(manifest));

		try {
			expect(readManifest(hash, 'site')).toEqual(manifest);
			expect(function() {
				readManifest(hash, 'other');
			}).toThrow('not other');
			expect(function() {
				readManifest('0'.repeat(64), 'site');
			}).toThrow('does not exist');
		} finally {
			fs.rmSync(manifestPath(hash), { force: true });
		}
	});
});

describe('StaticWebApp upload', function() {
	useIsolatedHome();
	const directories = useTempDirectories();

	afterEach(function() {
		pulumi.runtime.setAllConfig({});
	});

	function names(tree: TreeSnapshot, type: string) {
		return(ofType(tree, type).map(function(resource) {
			return(resource.name);
		}));
	}

	it('keeps one BucketObject per file, all retained, by default', async function() {
		const tree = await captureTree(function() {
			return(new StaticWebApp('site', { staticFilesPath: STATIC_DIRECTORY }));
		});

		expect(names(tree, 'gcp:storage/bucketObject:BucketObject').sort()).toEqual([ 'site-files-assets/a.js', 'site-files-index.html' ]);
		expect(ofType(tree, 'gcp:storage/bucketObject:BucketObject').map(function(resource) {
			return([ resource.name, resource.retainOnDelete ?? false ]);
		}).sort()).toEqual([ [ 'site-files-assets/a.js', true ], [ 'site-files-index.html', true ] ]);
		expect(names(tree, 'keeta:synced-folder:BucketSync')).toEqual([]);
	});

	it('retains only the assets with objects, as 2.0.0 did', async function() {
		const tree = await captureTree(function() {
			return(new StaticWebApp('site', { staticFilesPath: STATIC_DIRECTORY, upload: 'objects' }));
		});

		expect(names(tree, 'gcp:storage/bucketObject:BucketObject').sort()).toEqual([ 'site-files-assets/a.js', 'site-files-index.html' ]);
		expect(ofType(tree, 'gcp:storage/bucketObject:BucketObject').map(function(resource) {
			return([ resource.name, resource.retainOnDelete ?? false ]);
		}).sort()).toEqual([ [ 'site-files-assets/a.js', true ], [ 'site-files-index.html', false ] ]);
		expect(names(tree, 'keeta:synced-folder:BucketSync')).toEqual([]);
	});

	it('retains every object with objects-retain, under the same URNs', async function() {
		const tree = await captureTree(function() {
			return(new StaticWebApp('site', { staticFilesPath: STATIC_DIRECTORY, upload: 'objects-retain' }));
		});

		const objects = ofType(tree, 'gcp:storage/bucketObject:BucketObject');
		expect(objects.map(function(resource) {
			return([ resource.name, resource.retainOnDelete ]);
		}).sort()).toEqual([ [ 'site-files-assets/a.js', true ], [ 'site-files-index.html', true ] ]);
	});

	it('uploads with one command and no BucketObject with sync', async function() {
		const tree = await captureTree(function() {
			return(new StaticWebApp('site', { staticFilesPath: STATIC_DIRECTORY, upload: 'sync' }));
		});

		expect(names(tree, 'gcp:storage/bucketObject:BucketObject')).toEqual([]);
		expect(names(tree, 'keeta:synced-folder:BucketSync')).toEqual([ 'site-sync' ]);

		const [ syncCommand ] = ofType(tree, 'command:local:Command');
		expect(syncCommand.name).toBe('site-sync-sync');
		expect(syncCommand.parent).toContain('keeta:synced-folder:BucketSync::site-sync');

		const inputs = expectRecord(syncCommand.inputs, 'the command inputs');
		/* The script path is relative to the program, so it is the same on every machine */
		expect(inputs.create).toBe(inputs.update);
		expect(inputs.create).toMatch(/^node '(?!\/)[^']*bucket-sync-script\.js'$/);
		expect(inputs.delete).toBeUndefined();

		const environment = expectRecord(inputs.environment, 'the command environment');
		expect(Object.keys(environment).sort()).toEqual([ 'BUCKET_SYNC_BUCKET', 'BUCKET_SYNC_CONCURRENCY', 'BUCKET_SYNC_IMPERSONATE', 'BUCKET_SYNC_MANIFEST_HASH', 'BUCKET_SYNC_PROJECT' ]);

		/* The manifest the script will read: assets kept and first, index.html last, the cache headers of today */
		const hash = String(environment.BUCKET_SYNC_MANIFEST_HASH);
		const manifest = readManifest(hash, String(environment.BUCKET_SYNC_BUCKET));
		expect(manifest.retainPrefixes).toEqual([ 'assets/' ]);
		expect(manifest.uploadLast).toEqual([ 'index.html' ]);
		expect(manifest.files.map(function(syncFile) {
			return([ syncFile.name, syncFile.contentType, syncFile.cacheControl ]);
		})).toEqual([
			[ 'assets/a.js', 'application/javascript', 'public, max-age=86400' ],
			[ 'index.html', 'text/html', 'public, max-age=10' ]
		]);
	});

	it('uses its computeContentType for the synced files, as web-wallet does for apple-app-site-association', async function() {
		const directory = directories.make({ 'index.html': '<html></html>', '.well-known/apple-app-site-association': '{}' });
		const tree = await captureTree(function() {
			return(new StaticWebApp('site', {
				staticFilesPath: directory,
				upload: 'sync',
				computeContentType: function(file) {
					if (file.split('/').pop() === 'apple-app-site-association') {
						return('application/json');
					}

					return(contentTypeOf(file));
				}
			}));
		});

		const [ syncCommand ] = ofType(tree, 'command:local:Command');
		const environment = expectRecord(expectRecord(syncCommand.inputs, 'the command inputs').environment, 'the command environment');
		const manifest = readManifest(String(environment.BUCKET_SYNC_MANIFEST_HASH), String(environment.BUCKET_SYNC_BUCKET));
		expect(manifest.files.map(function(syncFile) {
			return([ syncFile.name, syncFile.contentType ]);
		})).toEqual([
			[ '.well-known/apple-app-site-association', 'application/json' ],
			[ 'index.html', 'text/html' ]
		]);
	});

	it('takes the retained prefixes and the sync options from its arguments', async function() {
		const tree = await captureTree(function() {
			return(new StaticWebApp('site', {
				staticFilesPath: STATIC_DIRECTORY,
				upload: 'sync',
				retainPrefixes: [ 'assets/', 'fonts/' ],
				sync: { uploadLast: [ 'index.html', 'sw.js' ], prune: false, concurrency: 4 }
			}));
		});

		const [ syncCommand ] = ofType(tree, 'command:local:Command');
		const environment = expectRecord(expectRecord(syncCommand.inputs, 'the command inputs').environment, 'the command environment');
		const manifest = readManifest(String(environment.BUCKET_SYNC_MANIFEST_HASH), String(environment.BUCKET_SYNC_BUCKET));
		expect(manifest).toMatchObject({ retainPrefixes: [ 'assets/', 'fonts/' ], uploadLast: [ 'index.html', 'sw.js' ], prune: false });
		expect(environment.BUCKET_SYNC_CONCURRENCY).toBe('4');
	});

	it('retains nothing with objects when retainPrefixes is empty', async function() {
		const tree = await captureTree(function() {
			return(new StaticWebApp('site', { staticFilesPath: STATIC_DIRECTORY, upload: 'objects', retainPrefixes: [] }));
		});

		expect(ofType(tree, 'gcp:storage/bucketObject:BucketObject').map(function(resource) {
			return(resource.retainOnDelete ?? false);
		})).toEqual([ false, false ]);
	});

	it('takes the upload from the stack configuration when the argument is not given', async function() {
		pulumi.runtime.setAllConfig({ [`${STATIC_WEB_APP_UPLOAD_CONFIG.namespace}:${STATIC_WEB_APP_UPLOAD_CONFIG.key}`]: 'sync' });

		const tree = await captureTree(function() {
			return(new StaticWebApp('site', { staticFilesPath: STATIC_DIRECTORY }));
		});

		expect(names(tree, 'keeta:synced-folder:BucketSync')).toEqual([ 'site-sync' ]);
	});

	it('rejects an unknown upload in the stack configuration', async function() {
		pulumi.runtime.setAllConfig({ [`${STATIC_WEB_APP_UPLOAD_CONFIG.namespace}:${STATIC_WEB_APP_UPLOAD_CONFIG.key}`]: 'rsync' });

		await expect(captureTree(function() {
			return(new StaticWebApp('site', { staticFilesPath: STATIC_DIRECTORY }));
		})).rejects.toThrow(/staticWebAppUpload is "rsync"/);
	});

	it('passes the account its GCP provider impersonates to the script', async function() {
		const tree = await captureTree(function() {
			const provider = new gcp.Provider('impersonating', { project: 'project-id', impersonateServiceAccount: 'deployer@project-id.iam.gserviceaccount.com' });

			return(new BucketSync('files', { bucketName: 'site', path: STATIC_DIRECTORY, project: 'project-id' }, { providers: [ provider ] }));
		});

		const [ syncCommand ] = ofType(tree, 'command:local:Command');
		const environment = expectRecord(expectRecord(syncCommand.inputs, 'the command inputs').environment, 'the command environment');
		expect(environment).toMatchObject({
			BUCKET_SYNC_BUCKET: 'site',
			BUCKET_SYNC_PROJECT: 'project-id',
			BUCKET_SYNC_IMPERSONATE: 'deployer@project-id.iam.gserviceaccount.com'
		});
	});
});
