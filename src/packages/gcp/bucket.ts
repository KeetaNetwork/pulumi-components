import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import * as command from '@pulumi/command';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { manifestHash, manifestPath } from './bucket-sync-core';
import type { BucketSyncFile, BucketSyncManifest } from './bucket-sync-core';
import { callerOf } from './client-auth';

type BucketObjectOptions = {
	retainOnDelete?: boolean;
};

/** Every file under a directory, as paths relative to it */
function filesOf(startDir: string): string[] {
	const files: string[] = [];

	for (const file of fs.readdirSync(startDir)) {
		const filePath = path.join(startDir, file);
		const fileInfo = fs.statSync(filePath);
		if (fileInfo.isDirectory()) {
			for (const subFile of filesOf(filePath)) {
				files.push(path.join(file, subFile));
			}
		} else {
			files.push(file);
		}
	}
	return(files);
}

/** The content type that the bucket components give a file by default, from its extension */
export function contentTypeOf(fileName: string): string {
	const ext = path.extname(fileName).toLowerCase();
	switch (ext) {
		case '.html':
			return('text/html');
		case '.css':
			return('text/css');
		case '.js':
			return('application/javascript');
		case '.json':
			return('application/json');
		case '.png':
			return('image/png');
		case '.jpg':
		case '.jpeg':
			return('image/jpeg');
		case '.webp':
			return('image/webp');
		case '.gif':
			return('image/gif');
		case '.svg':
			return('image/svg+xml');
		case '.woff2':
			return('font/woff2');
		case '.woff':
			return('font/woff');
		case '.md':
			return('text/markdown');
		case '.ts':
			return('application/typescript');
		case '.txt':
			return('text/plain');
		case '.xml':
			return('application/xml');
		default:
			return('application/octet-stream');
	}
}

/**
 * Reimplement the GoogleCloudFolder but with support for specifying
 * options to pass through for each file
 */
export interface GoogleCloudFolderArgs {
	/**
	 * The name of the bucket to sync to
	 */
	bucketName: pulumi.Input<string>;

	/**
	 * The path to sync
	 */
	path: string;

	/**
	 * The options to pass to the bucket object
	 */
	options?: {
		/**
		 * The options to set for every object
		 */
		object?: Partial<Omit<gcp.storage.BucketObjectArgs, 'bucket' | 'source' | 'name'>> & BucketObjectOptions;

		/**
		 * A function to generate the options for each object
		 * based on the path
		 */
		generated?: (path: string) => Partial<Omit<gcp.storage.BucketObjectArgs, 'bucket' | 'source' | 'name'>> & BucketObjectOptions;
	}

	/**
	 * Delete the source directory after the upload is complete
	 *
	 * (default is false)
	 */
	deleteAfterUpload?: boolean;

	/**
	 * Filter to apply to the files in the directory
	 */
	filter?: (file: string) => boolean;

	/**
	 * A function to compute the content type of the file
	 * based on the file name
	 */
	computeContentType?: (fileName: string) => string;
}

export class GoogleCloudFolderWithArgs extends pulumi.ComponentResource {
	readonly bucket: pulumi.Output<string>;
	readonly path: pulumi.Output<string>;
	private readonly computeContentType: (fileName: string) => string;

	private static getAllFiles(startDir: string): string[] {
		return(filesOf(startDir));
	}

	// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
	private static getComputedContentTypeFromFilename(this: void, fileName: string): string {
		return(contentTypeOf(fileName));
	}

	constructor(name: string, args: GoogleCloudFolderArgs, opts?: pulumi.ComponentResourceOptions) {
		super('keeta:synced-folder:GoogleCloudFolderWithArgs', name, args, opts);

		let files = GoogleCloudFolderWithArgs.getAllFiles(args.path);
		if (args.filter !== undefined) {
			files = files.filter(args.filter);
		}

		this.bucket = pulumi.output(args.bucketName);
		this.path = pulumi.output(args.path);
		this.computeContentType = args.computeContentType ?? ((fileName: string) => GoogleCloudFolderWithArgs.getComputedContentTypeFromFilename(fileName));

		const objects: gcp.storage.BucketObject[] = [];
		for (const file of files) {
			const filePath = path.join(args.path, file);

			/*
			 * If the file is a directory, skip it
			 */
			const fileInfo = fs.statSync(filePath);
			if (fileInfo.isDirectory()) {
				continue;
			}

			const resourceName = `${name}-${file.replace(/[^A-Za-z0-9/.]/g, '-')}`;

			/*
			 * Compute the combined Args+Options for the bucket
			 * object, then split them apart
			 */
			const bucketObjectArgs = {
				...args.options?.object,
				...args.options?.generated?.(file)
			};

			const bucketObjectOptions = {
				retainOnDelete: bucketObjectArgs?.retainOnDelete ?? args.options?.object?.retainOnDelete ?? false
			};
			delete bucketObjectArgs.retainOnDelete;

			/**
			 * Create the bucket object with the computed args and options
			 */
			const object = new gcp.storage.BucketObject(resourceName, {
				bucket: args.bucketName,
				source: new pulumi.asset.FileAsset(filePath),
				name: file,
				contentType: this.computeContentType(file),
				...bucketObjectArgs
			}, {
				parent: this,
				deleteBeforeReplace: true,
				...bucketObjectOptions
			});

			objects.push(object);
		}

		if (args.deleteAfterUpload) {
			pulumi.all(objects.map(function(object) {
				return(object.urn);
			})).apply(function() {
				fs.rmSync(args.path, {
					recursive: true
				});
			});
		}
	}
}

export interface BucketSyncArgs {
	/**
	 * The bucket to upload to
	 */
	bucketName: pulumi.Input<string>;

	/**
	 * The directory to upload. When the program writes or patches the files
	 * inside an `apply`, pass an output that resolves once they are written,
	 * so the manifest is built from the final files.
	 */
	path: pulumi.Input<string>;

	/**
	 * Filter to apply to the files in the directory (paths relative to it)
	 */
	filter?: (file: string) => boolean;

	/**
	 * The content type of a file (default: from its extension, as `GoogleCloudFolderWithArgs`)
	 */
	computeContentType?: (fileName: string) => string;

	/**
	 * The `Cache-Control` header of a file (default: none)
	 */
	computeCacheControl?: (fileName: string) => string | undefined;

	/**
	 * Object names under these prefixes are uploaded before every other
	 * file and are never deleted, so a page of an older version can still
	 * load them (default: none)
	 */
	retainPrefixes?: string[];

	/**
	 * Object names uploaded after every other file, one at a time, in this
	 * order (default: `['index.html']`)
	 */
	uploadLast?: string[];

	/**
	 * Delete objects that are not in the directory and not under
	 * `retainPrefixes`, after the uploads (default: true)
	 */
	prune?: boolean;

	/**
	 * The project the caller is in, for the credentials (default: the `gcp:project` of the stack)
	 */
	project?: pulumi.Input<string>;

	/**
	 * Uploads and deletes at the same time (default: 16)
	 */
	concurrency?: number;

	/**
	 * Delete the source directory after the upload is complete (default: false)
	 */
	deleteAfterUpload?: boolean;
}

/** The manifest of a directory: every file with its MD5, content type and cache header */
export function buildBucketSyncManifest(bucket: string, directory: string, args: Omit<BucketSyncArgs, 'bucketName' | 'path' | 'project' | 'concurrency' | 'deleteAfterUpload'>): BucketSyncManifest {
	let names = filesOf(directory);
	if (args.filter !== undefined) {
		names = names.filter(args.filter);
	}

	const computeContentType = args.computeContentType ?? contentTypeOf;
	const files = names.map(function(file): BucketSyncFile {
		const name = file.split(path.sep).join('/');
		const md5 = createHash('md5').update(fs.readFileSync(path.join(directory, file))).digest('base64');
		const cacheControl = args.computeCacheControl?.(name);

		return({
			name,
			md5,
			contentType: computeContentType(name),
			...(cacheControl === undefined ? {} : { cacheControl })
		});
	}).sort(function(a, b) {
		return(a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	});

	return({
		directory: path.resolve(directory),
		bucket,
		files,
		retainPrefixes: args.retainPrefixes ?? [],
		uploadLast: args.uploadLast ?? [ 'index.html' ],
		prune: args.prune ?? true
	});
}

/** A path for `/bin/sh`, in single quotes */
function shellQuote(value: string) {
	return(`'${value.replace(/'/g, "'\\''")}'`);
}

/**
 * Uploads a directory to a bucket with one resource instead of one
 * `BucketObject` per file.
 *
 * The program builds a manifest of the files (name, MD5, content type,
 * cache header) and writes it to a temporary file named by its hash. Only
 * the hash, the bucket and the caller go into the state, as the environment
 * of a `command.local.Command`, so the command runs exactly when the bucket
 * would end up different. The command runs a script of this package that
 * uploads the files that differ: `retainPrefixes` first, then the rest, then
 * `uploadLast`, and deletes stale objects after that.
 *
 * Pulumi does not track the objects: `pulumi refresh` does not see an object
 * changed by hand, and a removed `BucketSync` leaves the objects in the
 * bucket (delete the bucket, or the objects, to remove them).
 */
export class BucketSync extends pulumi.ComponentResource {
	readonly manifestHash: pulumi.Output<string>;
	readonly command: command.local.Command;

	constructor(name: string, args: BucketSyncArgs, opts?: pulumi.ComponentResourceOptions) {
		super('keeta:synced-folder:BucketSync', name, {}, opts);

		const manifestArgs = {
			filter: args.filter,
			computeContentType: args.computeContentType,
			computeCacheControl: args.computeCacheControl,
			retainPrefixes: args.retainPrefixes,
			uploadLast: args.uploadLast,
			prune: args.prune
		};

		this.manifestHash = pulumi.all([ args.bucketName, args.path ]).apply(function([ bucket, directory ]) {
			const manifest = buildBucketSyncManifest(bucket, directory, manifestArgs);
			const hash = manifestHash(manifest);
			const file = manifestPath(hash);
			fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
			fs.writeFileSync(file, JSON.stringify(manifest), { mode: 0o600 });

			return(hash);
		});

		const caller = callerOf(this, args.project ?? gcp.config.project);

		/*
		 * Relative to the program directory, where the command runs, so the
		 * command is the same on every machine that deploys the stack
		 */
		const script = path.relative(process.cwd(), path.join(__dirname, 'bucket-sync-script.js')).split(path.sep).join('/');
		const run = `node ${shellQuote(script)}`;

		this.command = new command.local.Command(`${name}-sync`, {
			create: run,
			update: run,
			addPreviousOutputInEnv: false,
			environment: {
				BUCKET_SYNC_MANIFEST_HASH: this.manifestHash,
				BUCKET_SYNC_BUCKET: args.bucketName,
				BUCKET_SYNC_PROJECT: caller.project.apply(function(project) {
					return(project ?? '');
				}),
				BUCKET_SYNC_IMPERSONATE: pulumi.output(caller.impersonateServiceAccount).apply(function(account) {
					return(account ?? '');
				}),
				BUCKET_SYNC_CONCURRENCY: String(args.concurrency ?? 16)
			}
		}, { parent: this });

		if (args.deleteAfterUpload) {
			pulumi.all([ this.command.stdout, args.path ]).apply(function([ _ignoreStdout, directory ]) {
				fs.rmSync(directory, { recursive: true, force: true });
			});
		}

		this.registerOutputs({ manifestHash: this.manifestHash });
	}
}
