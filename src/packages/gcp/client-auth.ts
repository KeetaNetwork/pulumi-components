import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { createRequire } from 'node:module';
import * as GoogleAuthLibrary from 'google-auth-library';

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
 * A `GoogleAuth` of the library given, for the inputs. Without an account to
 * impersonate it finds Application Default Credentials when it is used. With
 * one, it holds an `Impersonated` client that uses Application Default
 * Credentials as its source, and no token is requested here.
 */
async function googleAuthOf(library: typeof GoogleAuthLibrary, inputs: ClientAuthInputs, scopes: string[]): Promise<GoogleAuthLibrary.GoogleAuth> {
	const target = inputs.impersonateServiceAccount;
	if (target === undefined) {
		return(new library.GoogleAuth({ projectId: inputs.project, scopes }));
	}

	const source = new library.GoogleAuth({ projectId: inputs.project, scopes: [ CLOUD_PLATFORM_SCOPE ] });
	const impersonated = new library.Impersonated({
		sourceClient: await source.getClient(),
		targetPrincipal: target,
		targetScopes: scopes
	});

	return(new library.GoogleAuth({ projectId: inputs.project, scopes, authClient: impersonated }));
}

/**
 * A `GoogleAuth` for the inputs, made of the `google-auth-library` of this
 * package's own consumer. It is only for code that uses that library on its
 * own. Do not hand it to a Google Cloud client: the client's `google-gax` may
 * use another version of the library, and the two do not agree on their
 * types of headers. Use `googleAuthForClient` for a client.
 */
export async function googleAuthFrom(inputs: ClientAuthInputs, scopes: string[] = [ CLOUD_PLATFORM_SCOPE ]): Promise<GoogleAuthLibrary.GoogleAuth> {
	return(await googleAuthOf(GoogleAuthLibrary, inputs, scopes));
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
 * The `auth` option of a Google Cloud client (one built on `google-gax`) that
 * calls as the account that the inputs name. Without inputs or an account to
 * impersonate it is `undefined`, and the client finds the credentials of the
 * environment on its own.
 *
 * It is made of the `google-auth-library` of the client's own `google-gax`,
 * so the client never meets an object of another version of the library.
 */
export async function googleAuthForClient(clientPackage: string, inputs: ClientAuthInputs | undefined): Promise<GoogleAuthLibrary.GoogleAuth | undefined> {
	if (inputs?.impersonateServiceAccount === undefined) {
		return(undefined);
	}

	return(await googleAuthOf(authLibraryOf(clientPackage), inputs, [ CLOUD_PLATFORM_SCOPE ]));
}
