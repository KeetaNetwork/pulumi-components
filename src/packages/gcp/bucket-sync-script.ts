import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { googleAuthFrom } from './client-auth';
import { describeResult, fileOfObject, manifestHash, manifestPath, syncBucket } from './bucket-sync-core';
import type { BucketSyncFile, BucketSyncManifest, BucketSyncRemoteObject, BucketSyncStore } from './bucket-sync-core';

/*
 * The upload script that the `BucketSync` command runs, as
 * `node <this file>`. It reads the manifest that the program wrote, and
 * calls the JSON API of Cloud Storage with Application Default Credentials,
 * as the account that the deployment impersonates when it impersonates one.
 *
 * Environment:
 * - BUCKET_SYNC_MANIFEST_HASH: the manifest to apply (required)
 * - BUCKET_SYNC_BUCKET: the bucket; it must match the manifest (required)
 * - BUCKET_SYNC_PROJECT, BUCKET_SYNC_IMPERSONATE: who calls (optional)
 * - BUCKET_SYNC_CONCURRENCY: parallel uploads and deletes (default 16)
 */

const STORAGE_API = 'https://storage.googleapis.com/storage/v1';
const UPLOAD_API = 'https://storage.googleapis.com/upload/storage/v1';
const ATTEMPTS = 5;

type TokenSource = () => Promise<string>;
type Fetch = typeof fetch;

function isRetryable(status: number) {
	return(status === 408 || status === 429 || status >= 500);
}

async function pause(milliseconds: number) {
	await new Promise(function(resolve) {
		setTimeout(resolve, milliseconds);
	});
}

/** A call to the API with the token, retried on throttling, server errors and network errors */
async function call(fetchFunction: Fetch, token: TokenSource, url: string, init: RequestInit, allowStatus: number[] = []): Promise<Response> {
	let lastError: unknown;
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		if (attempt > 0) {
			await pause(500 * 2 ** (attempt - 1));
		}

		let response: Response;
		try {
			const headers = new Headers(init.headers);
			headers.set('Authorization', `Bearer ${await token()}`);
			response = await fetchFunction(url, { ...init, headers });
		} catch (error) {
			lastError = error;
			continue;
		}

		if (response.ok || allowStatus.includes(response.status)) {
			return(response);
		}

		const body = await response.text();
		lastError = new Error(`${init.method ?? 'GET'} ${url} failed with ${response.status}: ${body}`);
		if (!isRetryable(response.status)) {
			break;
		}
	}

	throw(lastError);
}

function optionalString(value: unknown): string | undefined {
	return(typeof value === 'string' ? value : undefined);
}

function sha256Of(contents: Buffer) {
	return(createHash('sha256').update(contents).digest('hex'));
}

/** The custom metadata key that holds the SHA-256 of an object's contents */
export const SHA256_METADATA = 'keeta-sha256';

function sha256OfItem(item: object): string | undefined {
	if (!('metadata' in item) || typeof item.metadata !== 'object' || item.metadata === null) {
		return(undefined);
	}

	return(SHA256_METADATA in item.metadata ? optionalString(item.metadata[SHA256_METADATA]) : undefined);
}

/** An object of a list response, or undefined for an item without a name */
function remoteObjectOf(item: unknown): BucketSyncRemoteObject | undefined {
	if (typeof item !== 'object' || item === null || !('name' in item) || typeof item.name !== 'string') {
		return(undefined);
	}

	return({
		name: item.name,
		sha256: sha256OfItem(item),
		contentType: 'contentType' in item ? optionalString(item.contentType) : undefined,
		cacheControl: 'cacheControl' in item ? optionalString(item.cacheControl) : undefined
	});
}

/** The objects and the next page token of a list response */
function listPageOf(page: unknown): { objects: BucketSyncRemoteObject[]; pageToken?: string } {
	const record = typeof page === 'object' && page !== null ? page : {};
	const items: unknown[] = 'items' in record && Array.isArray(record.items) ? record.items : [];
	const objects: BucketSyncRemoteObject[] = [];
	for (const item of items) {
		const object = remoteObjectOf(item);
		if (object !== undefined) {
			objects.push(object);
		}
	}

	return({ objects, pageToken: 'nextPageToken' in record ? optionalString(record.nextPageToken) : undefined });
}

/** The bucket through the JSON API of Cloud Storage */
export function gcsStore(bucket: string, directory: string, token: TokenSource, fetchFunction: Fetch = fetch): BucketSyncStore {
	const bucketPath = encodeURIComponent(bucket);

	return({
		list: async function() {
			const objects: BucketSyncRemoteObject[] = [];
			let pageToken: string | undefined;
			do {
				const url = new URL(`${STORAGE_API}/b/${bucketPath}/o`);
				url.searchParams.set('fields', 'items(name,contentType,cacheControl,metadata),nextPageToken');
				url.searchParams.set('maxResults', '1000');
				if (pageToken !== undefined) {
					url.searchParams.set('pageToken', pageToken);
				}

				const response = await call(fetchFunction, token, url.toString(), { method: 'GET' });
				const page = listPageOf(await response.json());
				objects.push(...page.objects);
				pageToken = page.pageToken;
			} while (pageToken !== undefined);

			return(objects);
		},

		upload: async function(file: BucketSyncFile) {
			const contents = fs.readFileSync(fileOfObject(directory, file.name));
			if (sha256Of(contents) !== file.sha256) {
				throw(new Error(`${file.name} changed after the program read it`));
			}

			const metadata = {
				name: file.name,
				contentType: file.contentType,
				metadata: { [SHA256_METADATA]: file.sha256 },
				...(file.cacheControl === undefined ? {} : { cacheControl: file.cacheControl })
			};
			const boundary = `bucket-sync-${createHash('sha256').update(file.name).update(file.sha256).digest('hex')}`;
			const body = Buffer.concat([
				Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${file.contentType}\r\n\r\n`),
				contents,
				Buffer.from(`\r\n--${boundary}--\r\n`)
			]);

			await call(fetchFunction, token, `${UPLOAD_API}/b/${bucketPath}/o?uploadType=multipart`, {
				method: 'POST',
				headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
				body
			});
		},

		remove: async function(name: string) {
			/* Already gone is fine */
			await call(fetchFunction, token, `${STORAGE_API}/b/${bucketPath}/o/${encodeURIComponent(name)}`, { method: 'DELETE' }, [ 404 ]);
		}
	});
}

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === '') {
		throw(new Error(`${name} is not set`));
	}

	return(value);
}

function nonEmpty(value: string | undefined): string | undefined {
	return(value === undefined || value === '' ? undefined : value);
}

function isStringArray(value: unknown): value is string[] {
	return(Array.isArray(value) && value.every(function(item) {
		return(typeof item === 'string');
	}));
}

function isManifestFile(value: unknown): value is BucketSyncFile {
	return(typeof value === 'object' && value !== null &&
		'name' in value && typeof value.name === 'string' &&
		'sha256' in value && typeof value.sha256 === 'string' &&
		'contentType' in value && typeof value.contentType === 'string' &&
		(!('cacheControl' in value) || value.cacheControl === undefined || typeof value.cacheControl === 'string'));
}

function isManifest(value: unknown): value is BucketSyncManifest {
	return(typeof value === 'object' && value !== null &&
		'directory' in value && typeof value.directory === 'string' &&
		'bucket' in value && typeof value.bucket === 'string' &&
		'files' in value && Array.isArray(value.files) && value.files.every(isManifestFile) &&
		'retainPrefixes' in value && isStringArray(value.retainPrefixes) &&
		'uploadLast' in value && isStringArray(value.uploadLast) &&
		'prune' in value && typeof value.prune === 'boolean');
}

/** Reads the manifest the program left for this hash, and checks that it is that manifest */
export function readManifest(hash: string, bucket: string): BucketSyncManifest {
	const file = manifestPath(hash);
	if (!fs.existsSync(file)) {
		throw(new Error(`The manifest ${file} does not exist. It is written by the Pulumi program, so the command only runs in the same "pulumi up" that wrote it.`));
	}

	const manifest: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
	if (!isManifest(manifest)) {
		throw(new Error(`The manifest ${file} is not a manifest`));
	}
	if (manifestHash(manifest) !== hash) {
		throw(new Error(`The manifest ${file} does not match its hash`));
	}
	if (manifest.bucket !== bucket) {
		throw(new Error(`The manifest is for bucket ${manifest.bucket}, not ${bucket}`));
	}

	return(manifest);
}

export async function main(): Promise<void> {
	const hash = requiredEnvironment('BUCKET_SYNC_MANIFEST_HASH');
	const bucket = requiredEnvironment('BUCKET_SYNC_BUCKET');
	const concurrency = Number(process.env.BUCKET_SYNC_CONCURRENCY ?? '16');
	const manifest = readManifest(hash, bucket);

	const auth = await googleAuthFrom({
		project: nonEmpty(process.env.BUCKET_SYNC_PROJECT),
		impersonateServiceAccount: nonEmpty(process.env.BUCKET_SYNC_IMPERSONATE)
	});
	const token = async function() {
		const accessToken = await auth.getAccessToken();
		if (accessToken === null || accessToken === undefined) {
			throw(new Error('No access token from Application Default Credentials'));
		}

		return(accessToken);
	};

	const result = await syncBucket(manifest, gcsStore(bucket, manifest.directory, token), Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 16);
	console.log(describeResult(bucket, result));
}

if (require.main === module) {
	main().catch(function(error: unknown) {
		console.error(error);
		process.exit(1);
	});
}
