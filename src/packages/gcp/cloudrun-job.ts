import * as pulumi from '@pulumi/pulumi';
import { randomUUID } from 'node:crypto';

import type { DeepInput, DeepOutput } from '../../types';
import type * as runTypes from '@google-cloud/run';

type ExecutionConditionState = 'STATE_UNSPECIFIED' | 'CONDITION_PENDING' | 'CONDITION_RECONCILING' | 'CONDITION_FAILED' | 'CONDITION_SUCCEEDED';

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

async function runJob(inputs: CloudRunJobExecutionInputs): Promise<ExecutionOutput> {
	// Dynamic import to avoid issues with Pulumi serialization
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-require-imports
	const { JobsClient } = require('@google-cloud/run') as typeof runTypes;

	const client = new JobsClient();
	const jobPath = `projects/${inputs.projectId}/locations/${inputs.region}/jobs/${inputs.jobName}`;

	// Run the job and wait for completion
	const [operation] = await client.runJob({ name: jobPath });
	const [execution] = await operation.promise();

	// Extract completion status from conditions
	let status: ExecutionConditionState = 'STATE_UNSPECIFIED';
	const conditions = execution.conditions ?? [];

	for (const condition of conditions) {
		if (condition.type === 'Completed') {
			const conditionState = condition.state;
			if (conditionState === 'CONDITION_SUCCEEDED' || conditionState === 'CONDITION_FAILED' || conditionState === 'CONDITION_RECONCILING') {
				status = conditionState;
			}
			if (status === 'CONDITION_FAILED') {
				const message = condition.message ?? 'Unknown error';
				const reason = condition.reason ?? 'Unknown reason';
				throw(new Error(`Job execution failed: ${reason} - ${message}. Logs: ${execution.logUri ?? 'N/A'}`));
			}
			break;
		}
	}

	return({
		executionName: execution.name ?? '',
		status,
		createTime: execution.createTime?.seconds?.toString() ?? null,
		completionTime: execution.completionTime?.seconds?.toString() ?? null,
		logUri: execution.logUri ?? null
	});
}

const cloudRunJobExecutionProvider: pulumi.dynamic.ResourceProvider = {
	async check(_ignore_oldInput: CloudRunJobExecutionInputs, newInput: CloudRunJobExecutionInputs) {
		return({ inputs: { ...newInput }});
	},

	async create(inputs: CloudRunJobExecutionInputs) {
		const id = randomUUID();
		const output = await runJob(inputs);
		return({ id, outs: output });
	},

	async update(_ignore_id: string, _ignore_oldInput: CloudRunJobExecutionInputs, newInput: CloudRunJobExecutionInputs) {
		const output = await runJob(newInput);
		return({ outs: output });
	},

	async delete() {
		// Nothing to clean up - executions are immutable
		return;
	}
};

export interface CloudRunJobExecutionArgs {
	/** The Cloud Run Job name (not the full resource path) */
	jobName: pulumi.Input<string>;

	/** GCP project ID */
	projectId: pulumi.Input<string>;

	/** GCP region where the job is deployed */
	region: pulumi.Input<string>;

	/** Trigger value - when this changes, the job will be re-executed */
	trigger: pulumi.Input<string>;
}

/**
 * Executes a Cloud Run Job and waits for completion.
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
