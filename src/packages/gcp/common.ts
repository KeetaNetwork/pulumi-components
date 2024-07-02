import type * as pulumi from '@pulumi/pulumi';
import type * as gcp from '@pulumi/gcp';

export type GCPCommonOptions = {
	/**
	 * GCP project name being deployed to
	 */
	project: string;

	/**
	 * Function to change the IAM policy for the project
	 */
	changeProjectIAMPolicy?: (role: string, members: pulumi.Input<string>[]) => pulumi.Input<pulumi.Resource> | undefined;

	/**
	 * Function to change the IAM policy for the container registry
	 */
	changeRegistryIAMPolicy?: (image: pulumi.Input<string>, role: 'read' | 'write', members: pulumi.Input<string>[]) => pulumi.Input<pulumi.Resource> | undefined;

	/**
	 * Configuration for the firewall rules created by this module
	 */
	firewallConfig?: Partial<ConstructorParameters<typeof gcp.compute.Firewall>[1]>;
};
