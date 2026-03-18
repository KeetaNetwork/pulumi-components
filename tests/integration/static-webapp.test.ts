import { describe, it, expect, afterAll } from 'vitest';
import * as pulumi from '@pulumi/pulumi';
import type { StaticWebAppArgs } from '../../src/packages/gcp/apps';
import { deployStack, destroyStack, type StackOutputs } from '../helpers/pulumi';

describe('StaticWebApp', function() {
	const stackName = `test-${Date.now()}`;
	let outputs: StackOutputs | undefined;

	it('deploys and serves content', async function() {
		outputs = await deployStack('examples/static-webapp', stackName);

		// Verify component output exists
		expect(outputs.staticApp).toBeDefined();

		// Get bucket name from component's registered outputs
		const staticApp = outputs.staticApp as { bucket: { name: string } };
		expect(staticApp.bucket?.name).toBeDefined();

		// Fetch the deployed content
		const bucketUrl = `https://storage.googleapis.com/${staticApp.bucket.name}/index.html`;
		const response = await fetch(bucketUrl);
		expect(response.ok).toBe(true);

		// Verify it's our HTML content
		const html = await response.text();
		expect(html).toContain('Static Web App');
		expect(html).toContain('Deployed successfully via Pulumi');
	}, 300_000); // 5 min timeout (simple GCS deployment)

	afterAll(async function() {
		await destroyStack('examples/static-webapp', stackName);
	}, 1_800_000); // 30 min timeout for destroy
});

describe('StaticWebAppArgs description field', () => {
	it('accepts pulumi.Input<string> and pulumi.Output<string>', () => {
		const withInput: StaticWebAppArgs = { staticFilesPath: './dist', description: 'my app' };
		const withOutput: StaticWebAppArgs = { staticFilesPath: './dist', description: pulumi.output('my app') };
		const withoutDescription: StaticWebAppArgs = { staticFilesPath: './dist' };

		expect(withInput.description).toBeDefined();
		expect(withOutput.description).toBeDefined();
		expect(withoutDescription.description).toBeUndefined();
	});
});
