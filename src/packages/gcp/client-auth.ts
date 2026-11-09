import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { GoogleAuth, Impersonated } from 'google-auth-library';

/**
 * What identifies the caller of a dynamic resource, and nothing that
 * authenticates it. These are inputs of the resource, so they are kept in
 * the state: a token or a key would be stored there too, and a token saved
 * at create time would be stale when the engine hands the old inputs back
 * (for `delete`). The credentials are found again when the resource runs.
 */
export interface ClientAuthInputs {
	project?: string;
	impersonateServiceAccount?: string;
}

/** What a provider (or a stand-in for it) says about the caller */
export interface ClientAuthProvider {
	project: pulumi.Output<string | undefined>;
	impersonateServiceAccount?: pulumi.Output<string | undefined>;
}

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * The caller of a component: the project that its arguments name, and the
 * account that the GCP resources of the component run as. That is the
 * account that the provider the component runs with (its `providers`)
 * impersonates, or without such a provider, the `gcp:impersonateServiceAccount`
 * of the stack configuration, which the default provider uses. Call it on the
 * component, once it is registered.
 */
export function callerOf(component: pulumi.Resource, project: pulumi.Input<string>): ClientAuthProvider {
	const provider = component.getProvider('gcp::');
	if (gcp.Provider.isInstance(provider)) {
		return({ project: pulumi.output(project), impersonateServiceAccount: provider.impersonateServiceAccount });
	}

	const configured = new pulumi.Config('gcp').get('impersonateServiceAccount');

	return({ project: pulumi.output(project), impersonateServiceAccount: pulumi.output(configured) });
}

/**
 * The project and the account to impersonate of the provider, or nothing
 * without a provider. Its `accessToken` and `credentials` are never read.
 */
export function clientAuthInputs(provider: ClientAuthProvider): pulumi.Output<ClientAuthInputs>;
export function clientAuthInputs(provider: ClientAuthProvider | undefined): pulumi.Output<ClientAuthInputs> | undefined;
export function clientAuthInputs(provider: ClientAuthProvider | undefined): pulumi.Output<ClientAuthInputs> | undefined {
	if (provider === undefined) {
		return(undefined);
	}

	return(pulumi.output({
		project: provider.project,
		impersonateServiceAccount: provider.impersonateServiceAccount
	}));
}

/**
 * A `GoogleAuth` for the inputs. Without an account to impersonate it finds
 * Application Default Credentials when it is used. With one, it holds an
 * `Impersonated` client that uses Application Default Credentials as its
 * source, and no token is requested here.
 */
export async function googleAuthFrom(inputs: ClientAuthInputs, scopes: string[] = [ CLOUD_PLATFORM_SCOPE ]): Promise<GoogleAuth> {
	const target = inputs.impersonateServiceAccount;
	if (target === undefined) {
		return(new GoogleAuth({ projectId: inputs.project, scopes }));
	}

	const source = new GoogleAuth({ projectId: inputs.project, scopes: [ CLOUD_PLATFORM_SCOPE ] });
	const impersonated = new Impersonated({
		sourceClient: await source.getClient(),
		targetPrincipal: target,
		targetScopes: scopes
	});

	return(new GoogleAuth({ projectId: inputs.project, scopes, authClient: impersonated }));
}
