import * as pulumi from '@pulumi/pulumi';
import * as googleAuth from 'google-auth-library';

import { randomUUID } from 'crypto';

import type { DeepInput, DeepOutput } from '../../types';

/**
 * Execution status from Cloud Run Jobs API
 */
type ExecutionStatus = 'EXECUTION_ENVIRONMENT_UNSPECIFIED' | 'EXECUTION_ENVIRONMENT_GEN1' | 'EXECUTION_ENVIRONMENT_GEN2';
type ExecutionConditionState = 'STATE_UNSPECIFIED' | 'CONDITION_PENDING' | 'CONDITION_RECONCILING' | 'CONDITION_FAILED' | 'CONDITION_SUCCEEDED';

interface ExecutionCondition {
	type: string;
	state: ExecutionConditionState;
	message?: string;
	reason?: string;
}

interface CloudRunJobExecutionInputs {
	jobName: string;
	projectId: string;
	region: string;
	trigger: string;
}

interface ExecutionOutput {
	executionName: string;
	status: ExecutionConditionState;
	createTime: string | null;
	completionTime: string | null;
	logUri: string | null;
}

type PulumiExecutionOutput = DeepOutput<ExecutionOutput>;

/**
 * Poll interval for checking execution status (in milliseconds)
 */
const POLL_INTERVAL_MS = 5000;

/**
 * Maximum time to wait for execution to complete (in milliseconds)
 */
const MAX_WAIT_TIME_MS = 30 * 60 * 1000; // 30 minutes

async function getAccessToken(): Promise<string> {
	const auth = new googleAuth.GoogleAuth({
		scopes: ['https://www.googleapis.com/auth/cloud-platform']
	});
	const client = await auth.getClient();
	const token = await client.getAccessToken();
	if (!token.token) {
		throw(new Error('Failed to get access token'));
	}
	return(token.token);
}

async function runJob(inputs: CloudRunJobExecutionInputs): Promise<ExecutionOutput> {
	const accessToken = await getAccessToken();

	const jobPath = `projects/${inputs.projectId}/locations/${inputs.region}/jobs/${inputs.jobName}`;
	const runUrl = `https://run.googleapis.com/v2/${jobPath}:run`;

	// Trigger the job execution
	const runResponse = await fetch(runUrl, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${accessToken}`,
			'Content-Type': 'application/json'
		}
	});

	if (!runResponse.ok) {
		const errorText = await runResponse.text();
		throw(new Error(`Failed to run job: ${runResponse.status} ${errorText}`));
	}

	const runResult = await runResponse.json() as { metadata?: { name?: string } };
	const executionName = runResult.metadata?.name;

	if (!executionName) {
		throw(new Error('No execution name returned from job run'));
	}

	// Poll for execution completion
	const startTime = Date.now();
	let lastStatus: ExecutionConditionState = 'CONDITION_PENDING';

	while (Date.now() - startTime < MAX_WAIT_TIME_MS) {
		const statusUrl = `https://run.googleapis.com/v2/${executionName}`;
		const statusResponse = await fetch(statusUrl, {
			headers: {
				'Authorization': `Bearer ${accessToken}`
			}
		});

		if (!statusResponse.ok) {
			const errorText = await statusResponse.text();
			throw(new Error(`Failed to get execution status: ${statusResponse.status} ${errorText}`));
		}

		const execution = await statusResponse.json() as {
			name: string;
			createTime?: string;
			completionTime?: string;
			logUri?: string;
			conditions?: ExecutionCondition[];
		};

		// Find the completion condition
		const completionCondition = execution.conditions?.find(function(c) {
			return(c.type === 'Completed');
		});

		if (completionCondition) {
			lastStatus = completionCondition.state;

			if (completionCondition.state === 'CONDITION_SUCCEEDED') {
				return({
					executionName: execution.name,
					status: 'CONDITION_SUCCEEDED',
					createTime: execution.createTime ?? null,
					completionTime: execution.completionTime ?? null,
					logUri: execution.logUri ?? null
				});
			}

			if (completionCondition.state === 'CONDITION_FAILED') {
				const message = completionCondition.message ?? 'Unknown error';
				const reason = completionCondition.reason ?? 'Unknown reason';
				throw(new Error(`Job execution failed: ${reason} - ${message}. Logs: ${execution.logUri ?? 'N/A'}`));
			}
		}

		// Wait before polling again
		await new Promise(function(resolve) {
			setTimeout(resolve, POLL_INTERVAL_MS);
		});
	}

	throw(new Error(`Job execution timed out after ${MAX_WAIT_TIME_MS / 1000} seconds. Last status: ${lastStatus}`));
}

const cloudRunJobExecutionProvider: pulumi.dynamic.ResourceProvider = {
	async check(_ignore_oldInput: CloudRunJobExecutionInputs, newInput: CloudRunJobExecutionInputs) {
		return({
			inputs: { ...newInput }
		});
	},

	async create(inputs: CloudRunJobExecutionInputs) {
		const id = randomUUID();
		const output = await runJob(inputs);

		return({
			id: id,
			outs: output
		});
	},

	async update(_ignore_id: string, _ignore_oldInput: CloudRunJobExecutionInputs, newInput: CloudRunJobExecutionInputs) {
		const output = await runJob(newInput);

		return({
			outs: output
		});
	},

	async delete() {
		// Nothing to clean up - executions are immutable
		return;
	}
};

export interface CloudRunJobExecutionArgs {
	/**
	 * The Cloud Run Job name (not the full resource path)
	 */
	jobName: pulumi.Input<string>;

	/**
	 * GCP project ID
	 */
	projectId: pulumi.Input<string>;

	/**
	 * GCP region where the job is deployed
	 */
	region: pulumi.Input<string>;

	/**
	 * Trigger value - when this changes, the job will be re-executed
	 * Typically set to the image digest or a hash of relevant inputs
	 */
	trigger: pulumi.Input<string>;
}

/**
 * CloudRunJobExecution executes a Cloud Run Job and waits for completion.
 * Re-executes when the trigger value changes.
 */
export class CloudRunJobExecution extends pulumi.dynamic.Resource implements PulumiExecutionOutput {
	public readonly executionName!: pulumi.Output<string>;
	public readonly status!: pulumi.Output<ExecutionConditionState>;
	public readonly createTime!: pulumi.Output<string | null>;
	public readonly completionTime!: pulumi.Output<string | null>;
	public readonly logUri!: pulumi.Output<string | null>;

	constructor(name: string, args: CloudRunJobExecutionArgs, opts?: pulumi.CustomResourceOptions) {
		const passArgs: DeepInput<CloudRunJobExecutionInputs> = {
			jobName: args.jobName,
			projectId: args.projectId,
			region: args.region,
			trigger: args.trigger
		};

		super(cloudRunJobExecutionProvider, name, {
			...passArgs,
			executionName: undefined,
			status: undefined,
			createTime: undefined,
			completionTime: undefined,
			logUri: undefined
		}, opts);
	}
}

export default CloudRunJobExecution;
