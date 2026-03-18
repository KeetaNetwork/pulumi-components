import type * as pulumi from '@pulumi/pulumi';
import type * as gcp from '@pulumi/gcp';

export type GCPCommonOptions = {
	/**
	 * GCP project name being deployed to
	 */
	project: pulumi.Input<string>;

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

/**
 * Certificate Manager certificate type - uses id instead of name
 */
export type CertificateManagerCert = Pick<gcp.certificatemanager.Certificate, 'id' | 'sanDnsnames'>;

/**
 * Compute Managed SSL certificate type
 */
export type ComputeManagedSslCert = Pick<gcp.compute.ManagedSslCertificate, 'id' | 'certificateId'>;

/**
 * Extract the service URL from Cloud Run service statuses
 */
export function extractServiceURL(statuses: gcp.types.output.cloudrun.ServiceStatus[] | undefined): string | undefined {
	return(statuses?.[0]?.url);
}
