import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import * as fs from 'fs';
import * as path from 'path';

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
		object?: Partial<Omit<gcp.storage.BucketObjectArgs, 'bucket' | 'source' | 'name'>>;

		/**
		 * A function to generate the options for each object
		 * based on the path
		 */
		generated?: (path: string) => Partial<Omit<gcp.storage.BucketObjectArgs, 'bucket' | 'source' | 'name'>>;
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
		const files: string[] = [];

		for (const file of fs.readdirSync(startDir)) {
			const filePath = path.join(startDir, file);
			const fileInfo = fs.statSync(filePath);
			if (fileInfo.isDirectory()) {
				for (const subFile of GoogleCloudFolderWithArgs.getAllFiles(filePath)) {
					files.push(path.join(file, subFile));
				}
			} else {
				files.push(file);
			}
		}
		return files;
	}

	private static getComputedContentTypeFromFilename(this: void, fileName: string): string {
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

	constructor(name: string, args: GoogleCloudFolderArgs, opts?: pulumi.ComponentResourceOptions) {
		super('keeta:synced-folder:GoogleCloudFolderWithArgs', name, args, opts);

		let files = GoogleCloudFolderWithArgs.getAllFiles(args.path);
		if (args.filter !== undefined) {
			files = files.filter(args.filter);
		}

		this.bucket = pulumi.output(args.bucketName);
		this.path = pulumi.output(args.path);
		this.computeContentType = args.computeContentType ?? GoogleCloudFolderWithArgs.getComputedContentTypeFromFilename;

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

			const object = new gcp.storage.BucketObject(resourceName, {
				bucket: args.bucketName,
				source: new pulumi.asset.FileAsset(filePath),
				name: file,
				contentType: this.computeContentType(file),
				...args.options?.object,
				...args.options?.generated?.(file)
			}, {
				parent: this,
				deleteBeforeReplace: true
			});

			objects.push(object);
		}

		if (args.deleteAfterUpload) {
			pulumi.all(objects.map(function(object) {
				return object.urn;
			})).apply(function() {
				fs.rmSync(args.path, {
					recursive: true
				});
			});
		}
	}
}
