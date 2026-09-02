import { describe, it, expect, afterAll } from 'vitest';
import { deployStack, destroyStack, type StackOutputs } from '../helpers/pulumi';
import { listManagedInstances, getSerialPortOutput, resetInstance, readLogs, waitFor, lastCloudInitFinishedAt, type ManagedInstance } from '../helpers/gcloud';

describe('ContainerMIG', function() {
	const stackName = `test-${Date.now()}`;
	let outputs: StackOutputs | undefined;
	let instance: ManagedInstance | undefined;

	function project(): string {
		return(outputs!.project as string);
	}

	function heartbeat(): string {
		return(`marker=${outputs!.marker as string} lines=2`);
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
			return(listManagedInstances(project(), outputs!.migRegion as string, outputs!.migName as string)[0]);
		}, 20, 15_000);

		// The unit's output (container stdout included) goes to the serial console
		const serial = await waitFor('the container heartbeat on the serial console', function() {
			const output = getSerialPortOutput(project(), instance!);
			return(output.includes(heartbeat()) ? output : undefined);
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

		const bootBefore = lastCloudInitFinishedAt(getSerialPortOutput(project(), instance!));
		expect(bootBefore).toBeDefined();

		resetInstance(project(), instance!);

		// A new cloud-init completion, followed by a heartbeat
		const serial = await waitFor('a post-reset boot with a heartbeat', function() {
			const output = getSerialPortOutput(project(), instance!);
			const bootAfter = lastCloudInitFinishedAt(output);
			if (bootAfter === undefined || bootAfter === bootBefore) {
				return(undefined);
			}

			const lastBoot = output.lastIndexOf('Cloud-init v.');
			return(output.indexOf(heartbeat(), lastBoot) !== -1 ? output : undefined);
		}, 40, 15_000);

		expect(lastCloudInitFinishedAt(serial)).not.toBe(bootBefore);
	}, 900_000);

	afterAll(async function() {
		await destroyStack('examples/container-mig', stackName);
	}, 1_800_000);
});
