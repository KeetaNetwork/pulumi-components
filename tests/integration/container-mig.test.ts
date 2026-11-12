import { describe, it, expect, afterAll } from 'vitest';
import { deployStack, destroyStack, type StackOutputs } from '../helpers/pulumi';
import { listManagedInstances, getSerialPortOutput, resetInstance, readLogs, waitFor, lastCloudInitFinishedAt, type ManagedInstance } from '../helpers/gcloud';
import { expectDefined, expectString } from '../helpers/narrow';

describe('ContainerMIG', function() {
	const stackName = `test-${Date.now()}`;
	let outputs: StackOutputs | undefined;
	let instance: ManagedInstance | undefined;

	function output(key: string): string {
		return(expectString(expectDefined(outputs, 'the stack outputs')[key], `the stack output ${key}`));
	}

	function project(): string {
		return(output('project'));
	}

	function heartbeat(): string {
		return(`marker=${output('marker')} lines=2`);
	}

	function currentInstance(): ManagedInstance {
		return(expectDefined(instance, 'the managed instance'));
	}

	it('deploys a managed instance group running a container via cloud-init', async function() {
		outputs = await deployStack('examples/container-mig', stackName);

		expect(outputs.project).toBeDefined();
		expect(outputs.migName).toBeDefined();
		expect(outputs.migRegion).toBeDefined();
		expect(outputs.marker).toBeDefined();
	}, 1_800_000);

	it('starts the container with its environment and arguments', async function() {
		expect(outputs).toBeDefined();

		instance = await waitFor('a managed instance', function() {
			return(listManagedInstances(project(), output('migRegion'), output('migName'))[0]);
		}, 20, 15_000);

		// The unit's output (container stdout included) goes to the serial console
		const serial = await waitFor('the container heartbeat on the serial console', function() {
			const serialOutput = getSerialPortOutput(project(), currentInstance());
			return(serialOutput.includes(heartbeat()) ? serialOutput : undefined);
		}, 40, 15_000);

		expect(serial).toContain(heartbeat());
	}, 900_000);

	it('ships container output to Cloud Logging via gcplogs', async function() {
		expect(outputs).toBeDefined();

		const filter = `logName="projects/${project()}/logs/gcplogs-docker-driver" AND resource.type="gce_instance" AND "${heartbeat()}"`;
		const entries = await waitFor('gcplogs entries in Cloud Logging', function() {
			const found = readLogs(project(), filter, 1);
			return(found.length > 0 ? found : undefined);
		}, 20, 15_000);

		expect(entries.length).toBeGreaterThan(0);
	}, 600_000);

	it('starts the container again after a VM reset', async function() {
		expect(instance).toBeDefined();

		const bootBefore = lastCloudInitFinishedAt(getSerialPortOutput(project(), currentInstance()));
		expect(bootBefore).toBeDefined();

		resetInstance(project(), currentInstance());

		// A new cloud-init completion, followed by a heartbeat
		const serial = await waitFor('a post-reset boot with a heartbeat', function() {
			const serialOutput = getSerialPortOutput(project(), currentInstance());
			const bootAfter = lastCloudInitFinishedAt(serialOutput);
			if (bootAfter === undefined || bootAfter === bootBefore) {
				return(undefined);
			}

			const lastBoot = serialOutput.lastIndexOf('Cloud-init v.');
			return(serialOutput.includes(heartbeat(), lastBoot) ? serialOutput : undefined);
		}, 40, 15_000);

		expect(lastCloudInitFinishedAt(serial)).not.toBe(bootBefore);
	}, 900_000);

	afterAll(async function() {
		await destroyStack('examples/container-mig', stackName);
	}, 1_800_000);
});
