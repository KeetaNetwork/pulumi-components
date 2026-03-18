import { describe, it, expect, beforeAll } from 'vitest';
import * as pulumi from '@pulumi/pulumi';
import type {
	StaticWebAppArgs,
	CloudRunServiceArgs,
	FullStackAppArgs
} from '../../src/packages/gcp/apps';

// Set up Pulumi mocks before tests run
beforeAll(async () => {
	pulumi.runtime.setMocks({
		newResource(args) {
			return { id: `${args.name}-id`, state: args.inputs };
		},
		call(args) {
			return args.inputs;
		}
	});
});

describe('StaticWebAppArgs description field', () => {
	it('accepts a plain string as description', () => {
		const args: StaticWebAppArgs = {
			staticFilesPath: './dist',
			description: 'My static web app'
		};
		expect(args.description).toBe('My static web app');
	});

	it('accepts a pulumi.Input<string> as description', () => {
		const inputDescription: pulumi.Input<string> = 'Input string description';
		const args: StaticWebAppArgs = {
			staticFilesPath: './dist',
			description: inputDescription
		};
		expect(args.description).toBeDefined();
	});

	it('accepts a pulumi.Output<string> as description', () => {
		const outputDescription: pulumi.Output<string> = pulumi.output('Output string description');
		const args: StaticWebAppArgs = {
			staticFilesPath: './dist',
			description: outputDescription
		};
		expect(args.description).toBeDefined();
	});

	it('allows description to be omitted (optional)', () => {
		const args: StaticWebAppArgs = {
			staticFilesPath: './dist'
		};
		expect(args.description).toBeUndefined();
	});
});

describe('CloudRunServiceArgs description field', () => {
	const baseArgs: Omit<CloudRunServiceArgs, 'description'> = {
		gcp: { project: 'my-project' },
		region: 'us-central1',
		image: { uri: 'gcr.io/my-project/my-image:latest' }
	};

	it('accepts a plain string as description', () => {
		const args: CloudRunServiceArgs = {
			...baseArgs,
			description: 'My cloud run service'
		};
		expect(args.description).toBe('My cloud run service');
	});

	it('accepts a pulumi.Input<string> as description', () => {
		const inputDescription: pulumi.Input<string> = 'Input string description';
		const args: CloudRunServiceArgs = {
			...baseArgs,
			description: inputDescription
		};
		expect(args.description).toBeDefined();
	});

	it('accepts a pulumi.Output<string> as description', () => {
		const outputDescription: pulumi.Output<string> = pulumi.output('Output string description');
		const args: CloudRunServiceArgs = {
			...baseArgs,
			description: outputDescription
		};
		expect(args.description).toBeDefined();
	});

	it('allows description to be omitted (optional)', () => {
		const args: CloudRunServiceArgs = {
			...baseArgs
		};
		expect(args.description).toBeUndefined();
	});
});

describe('FullStackAppArgs description field', () => {
	const baseArgs: Omit<FullStackAppArgs, 'description'> = {
		loadBalancer: {
			domain: 'app.example.com',
			ssl: { domains: ['app.example.com'] }
		},
		frontend: {
			staticFilesPath: './dist'
		},
		backend: {
			gcp: { project: 'my-project' },
			region: 'us-central1',
			image: { uri: 'gcr.io/my-project/my-image:latest' }
		}
	};

	it('accepts a plain string as description', () => {
		const args: FullStackAppArgs = {
			...baseArgs,
			description: 'My full stack app'
		};
		expect(args.description).toBe('My full stack app');
	});

	it('accepts a pulumi.Input<string> as description', () => {
		const inputDescription: pulumi.Input<string> = 'Input string description';
		const args: FullStackAppArgs = {
			...baseArgs,
			description: inputDescription
		};
		expect(args.description).toBeDefined();
	});

	it('accepts a pulumi.Output<string> as description', () => {
		const outputDescription: pulumi.Output<string> = pulumi.output('Output string description');
		const args: FullStackAppArgs = {
			...baseArgs,
			description: outputDescription
		};
		expect(args.description).toBeDefined();
	});

	it('allows description to be omitted (optional)', () => {
		const args: FullStackAppArgs = {
			...baseArgs
		};
		expect(args.description).toBeUndefined();
	});
});
