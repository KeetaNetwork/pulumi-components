import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { createRequire } from 'node:module';
import { GoogleAuth, Impersonated } from 'google-auth-library';
import type * as GoogleAuthLibrary from 'google-auth-library';

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
 *
 * It is made of the `google-auth-library` of this package's own consumer, so
 * it is only for code that uses that library on its own. Do not hand it to a
 * Google Cloud client: the client's `google-gax` may use another version of
 * the library, and the two do not agree on their types of headers. Use
 * `authenticateAs` for a client.
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

function isAuthLibrary(value: unknown): value is typeof GoogleAuthLibrary {
	return(typeof value === 'object' && value !== null && 'Impersonated' in value && typeof value.Impersonated === 'function');
}

/**
 * The `google-auth-library` that the Google Cloud client package works
 * with: the one of its own `google-gax`, wherever the consumer's package
 * manager put them.
 */
function authLibraryOf(clientPackage: string): typeof GoogleAuthLibrary {
	const requireFromClient = createRequire(require.resolve(clientPackage));
	const gax: unknown = requireFromClient('google-gax');
	const library: unknown = typeof gax === 'object' && gax !== null && 'googleAuthLibrary' in gax && gax.googleAuthLibrary;
	if (!isAuthLibrary(library)) {
		throw(new TypeError(`google-gax of ${clientPackage} does not export google-auth-library`));
	}

	return(library);
}

/**
 * Makes a Google Cloud client (one built on `google-gax`) call as the
 * account that the inputs name. Without an account to impersonate the client
 * is left as it is: it finds the credentials of the environment on its own.
 *
 * The impersonation is built from the `google-auth-library` of the client's
 * own `google-gax` and wraps the credentials the client found, so the client
 * never meets an object of another version of the library.
 */
export function authenticateAs(client: { auth: GoogleAuthLibrary.GoogleAuth }, clientPackage: string, inputs: ClientAuthInputs): void {
	const target = inputs.impersonateServiceAccount;
	if (target === undefined) {
		return;
	}

	const library = authLibraryOf(clientPackage);
	const auth = client.auth;
	const getEnvironmentClient = auth.getClient.bind(auth);
	let impersonated: GoogleAuthLibrary.Impersonated | undefined;
	auth.getClient = async function() {
		impersonated ??= new library.Impersonated({
			sourceClient: await getEnvironmentClient(),
			targetPrincipal: target,
			targetScopes: [ CLOUD_PLATFORM_SCOPE ]
		});

		return(impersonated);
	};
}
