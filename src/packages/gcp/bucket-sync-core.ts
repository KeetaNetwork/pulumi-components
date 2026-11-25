import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/*
 * The part of `BucketSync` that decides what to upload and what to delete.
 * It has no Pulumi and no Google Cloud import, so the upload script loads
 * it quickly and the tests run it against a bucket in memory.
 */

/** One file of the directory, as the bucket should hold it */
export interface BucketSyncFile {
	/** The object name: the path relative to the directory, with `/` separators */
	name: string;
	/** SHA-256 of the contents, hex; the upload keeps it in the object's metadata (`keeta-sha256`) */
	sha256: string;
	contentType: string;
	cacheControl?: string;
}

/** What one run of the upload script does; written by the program, read by the script */
export interface BucketSyncManifest {
	/** The directory the files are read from; it is not part of the hash, because it can be a new temporary directory on each run */
	directory: string;
	bucket: string;
	/**
	 * The folder of the bucket the files go to: `''` for the root, else a
	 * name ending in `/`. Every other name in the manifest is relative to
	 * it, and objects outside it are never listed, changed or deleted.
	 */
	prefix: string;
	files: BucketSyncFile[];
	/** Object names under these prefixes are uploaded first and never deleted */
	retainPrefixes: string[];
	/** Object names uploaded last, one at a time, in this order */
	uploadLast: string[];
	/** Delete objects that are not in `files` and not under `retainPrefixes` */
	prune: boolean;
}

/** An object as the bucket lists it */
export interface BucketSyncRemoteObject {
	name: string;
	/** The `keeta-sha256` metadata of the object, which only objects uploaded by `BucketSync` have */
	sha256?: string;
	contentType?: string;
	cacheControl?: string;
}

/** The calls the sync makes to a bucket */
export interface BucketSyncStore {
	list(): Promise<BucketSyncRemoteObject[]>;
	upload(file: BucketSyncFile): Promise<void>;
	remove(name: string): Promise<void>;
}

export interface BucketSyncResult {
	uploaded: string[];
	deleted: string[];
	unchanged: number;
	/** Objects that are in the bucket but not in the manifest, and were kept because of `retainPrefixes` */
	retained: number;
}

/** Orders object names by their code units, the same on every machine (a locale order is not) */
export function compareNames(a: string, b: string): number {
	if (a === b) {
		return(0);
	}

	return(a < b ? -1 : 1);
}

/**
 * The hash that stands for the manifest in the state: it changes whenever
 * the bucket would end up different, and not when only the directory moves.
 */
export function manifestHash(manifest: BucketSyncManifest): string {
	const files = [ ...manifest.files ].sort(function(a, b) {
		return(compareNames(a.name, b.name));
	});
	const stable = {
		bucket: manifest.bucket,
		prefix: manifest.prefix,
		files: files.map(function(file) {
			return([ file.name, file.sha256, file.contentType, file.cacheControl ?? null ]);
		}),
		retainPrefixes: manifest.retainPrefixes,
		uploadLast: manifest.uploadLast,
		prune: manifest.prune
	};

	return(createHash('sha256').update(JSON.stringify(stable)).digest('hex'));
}

/** A destination folder as the manifest holds it: no leading `/`, and a trailing `/` unless it is the root */
export function normalizePrefix(prefix: string | undefined): string {
	const trimmed = (prefix ?? '').replace(/^\/+/, '');
	if (trimmed === '' || trimmed.endsWith('/')) {
		return(trimmed);
	}

	return(`${trimmed}/`);
}

/** The directory of the manifests, per user, so no other account can place a manifest there */
export function manifestDirectory(): string {
	const user = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';

	return(path.join(os.tmpdir(), `keeta-bucket-sync-${user}`));
}

/**
 * Where the program leaves the manifest for the script. Only the hash goes
 * into the state, and the script finds the file from it, so no path of the
 * machine that deploys ends up in the inputs of the command.
 */
export function manifestPath(hash: string): string {
	if (!/^[0-9a-f]{64}$/.test(hash)) {
		throw(new Error('A manifest hash is 64 lowercase hex digits'));
	}

	return(path.join(manifestDirectory(), `${hash}.json`));
}

/**
 * The file an object name stands for, inside the directory. A name that is
 * absolute or climbs out of the directory is refused.
 */
export function fileOfObject(directory: string, name: string): string {
	const root = path.resolve(directory);
	const file = path.resolve(root, ...name.split('/'));
	if (name === '' || path.isAbsolute(name) || !file.startsWith(root + path.sep)) {
		throw(new Error(`The object name ${JSON.stringify(name)} is not inside the directory`));
	}

	return(file);
}

function isRetained(name: string, retainPrefixes: string[]): boolean {
	return(retainPrefixes.some(function(prefix) {
		return(name.startsWith(prefix));
	}));
}

function isCurrent(file: BucketSyncFile, remote: BucketSyncRemoteObject | undefined): boolean {
	if (remote === undefined) {
		return(false);
	}

	return(remote.sha256 === file.sha256 && remote.contentType === file.contentType && (remote.cacheControl ?? undefined) === (file.cacheControl ?? undefined));
}

/** Runs `task` over `items` with at most `concurrency` at a time, and fails with the first error */
async function eachLimited<T>(items: T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	let failed = false;
	const workers: Promise<void>[] = [];
	for (let worker = 0; worker < Math.min(concurrency, items.length); worker++) {
		workers.push((async function() {
			while (next < items.length && !failed) {
				const item = items[next];
				next++;
				try {
					await task(item);
				} catch (error) {
					/* The other workers stop taking new items */
					failed = true;
					throw(error);
				}
			}
		})());
	}

	await Promise.all(workers);
}

export interface BucketSyncPlan {
	/** Upload groups, each finished before the next starts */
	stages: BucketSyncFile[][];
	/** Uploaded one at a time, after every stage */
	last: BucketSyncFile[];
	deletes: string[];
	unchanged: number;
	retained: number;
}

/**
 * What to change in the bucket. Retained files (the hashed assets) go first,
 * so a page never names an asset that is not there yet; then the other
 * files; then `uploadLast` (`index.html`), which switches users to the new
 * version. Deletes come after that, so nothing the old `index.html` names
 * goes away while it is still served.
 */
export function planSync(manifest: BucketSyncManifest, remote: BucketSyncRemoteObject[]): BucketSyncPlan {
	const remoteByName = new Map(remote.map(function(object) {
		return([ object.name, object ] as const);
	}));
	const wanted = new Set(manifest.files.map(function(file) {
		return(file.name);
	}));

	const changed = manifest.files.filter(function(file) {
		return(!isCurrent(file, remoteByName.get(file.name)));
	});

	const lastOrder = new Map(manifest.uploadLast.map(function(name, index) {
		return([ name, index ] as const);
	}));
	const last = changed.filter(function(file) {
		return(lastOrder.has(file.name));
	}).sort(function(a, b) {
		return((lastOrder.get(a.name) ?? 0) - (lastOrder.get(b.name) ?? 0));
	});
	const retainedFirst = changed.filter(function(file) {
		return(!lastOrder.has(file.name) && isRetained(file.name, manifest.retainPrefixes));
	});
	const others = changed.filter(function(file) {
		return(!lastOrder.has(file.name) && !isRetained(file.name, manifest.retainPrefixes));
	});

	const deletes: string[] = [];
	let retained = 0;
	for (const object of remote) {
		if (wanted.has(object.name)) {
			continue;
		}

		if (isRetained(object.name, manifest.retainPrefixes)) {
			retained++;
		} else if (manifest.prune) {
			deletes.push(object.name);
		}
	}

	return({
		stages: [ retainedFirst, others ].filter(function(stage) {
			return(stage.length > 0);
		}),
		last,
		deletes: [ ...deletes ].sort(compareNames),
		unchanged: manifest.files.length - changed.length,
		retained
	});
}

/** Brings the bucket to the manifest */
export async function syncBucket(manifest: BucketSyncManifest, store: BucketSyncStore, concurrency = 16): Promise<BucketSyncResult> {
	const plan = planSync(manifest, await store.list());
	const uploaded: string[] = [];

	for (const stage of plan.stages) {
		await eachLimited(stage, concurrency, async function(file) {
			await store.upload(file);
			uploaded.push(file.name);
		});
	}

	for (const file of plan.last) {
		await store.upload(file);
		uploaded.push(file.name);
	}

	await eachLimited(plan.deletes, concurrency, async function(name) {
		await store.remove(name);
	});

	return({ uploaded, deleted: plan.deletes, unchanged: plan.unchanged, retained: plan.retained });
}

/** A short report for the command's output, which Pulumi keeps in the state, so long lists are cut */
export function describeResult(bucket: string, result: BucketSyncResult, listLimit = 20): string {
	const lines = [ `gs://${bucket}: ${result.uploaded.length} uploaded, ${result.unchanged} unchanged, ${result.deleted.length} deleted, ${result.retained} retained` ];
	for (const [ label, names ] of [ [ 'uploaded', result.uploaded ], [ 'deleted', result.deleted ] ] as const) {
		for (const name of names.slice(0, listLimit)) {
			lines.push(`  ${label} ${name}`);
		}
		if (names.length > listLimit) {
			lines.push(`  ... and ${names.length - listLimit} more ${label}`);
		}
	}

	return(lines.join('\n'));
}
