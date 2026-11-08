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
 * account that the provider the component runs with (its `providers`)
 * impersonates, if any. Call it on the component, once it is registered.
 */
export function callerOf(component: pulumi.Resource, project: pulumi.Input<string>): ClientAuthProvider {
	const provider = component.getProvider('gcp::');
	let impersonateServiceAccount: pulumi.Output<string | undefined> | undefined;
	if (provider instanceof gcp.Provider) {
		impersonateServiceAccount = provider.impersonateServiceAccount;
	}

	return({ project: pulumi.output(project), impersonateServiceAccount });
}

/**
 * The project and the account to impersonate of the provider. Its
 * `accessToken` and `credentials` are never read.
 */
export function clientAuthInputs(provider: ClientAuthProvider): pulumi.Output<ClientAuthInputs> {
	return(pulumi.output({
		project: provider.project,
		impersonateServiceAccount: provider.impersonateServiceAccount
	}));
}

/**
 * A `GoogleAuth` that resolves its credentials from Application Default
 * Credentials when it is used (nothing is called here), impersonating the
 * account of the inputs when there is one.
 */
export function googleAuthFrom(inputs: ClientAuthInputs, scopes: string[] = [ CLOUD_PLATFORM_SCOPE ]): GoogleAuth {
	const auth = new GoogleAuth({ projectId: inputs.project, scopes });

	const target = inputs.impersonateServiceAccount;
	if (target === undefined) {
		return(auth);
	}

	const source = new GoogleAuth({ projectId: inputs.project, scopes: [ CLOUD_PLATFORM_SCOPE ] });
	let impersonated: Impersonated | undefined;
	auth.getClient = async function() {
		impersonated ??= new Impersonated({
			sourceClient: await source.getClient(),
			targetPrincipal: target,
			targetScopes: scopes
		});

		return(impersonated);
	};

	return(auth);
}
