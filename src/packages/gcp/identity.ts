import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { movedFrom } from './aliases';
import type { GCPCommonOptions } from './common';
import { generateName } from '../../utils';

/**
 * What a component that receives the identity of its app needs to know: the
 * account it runs as, and the grants it has to wait for. A component with
 * one does not grant project roles for itself.
 */
export interface ServiceIdentityRef {
	email: pulumi.Input<string>;
	grants: pulumi.Input<pulumi.Resource>[];

	/**
	 * The project roles that the identity grants itself. A component skips
	 * (or retains) its own grant of a role only if it is in this list.
	 */
	grantedRoles: string[];
}

export interface ServiceIdentityArgs {
	gcp: Pick<GCPCommonOptions, 'project' | 'changeProjectIAMPolicy'>;

	/**
	 * The service account of the caller. When it is not given the identity
	 * creates the account of the app.
	 */
	account?: Pick<gcp.serviceaccount.Account, 'email'>;

	/**
	 * Whether the identity grants the project roles to the account. The
	 * caller decides this once (`grantIAMRoles`, and an account of their own
	 * is never granted anything).
	 */
	grantRoles: boolean;

	/**
	 * The app, which was the parent of the account and of the log writer
	 * grant in 1.0.95 (they answer to their old URN).
	 */
	app: pulumi.Resource;

	/**
	 * The database of the app, if it has one: the Cloud SQL client role is
	 * granted, and its grant was a child of the database in 1.0.95
	 */
	database?: pulumi.Resource;

	/** Whether the app has a worker, which writes metrics */
	worker: boolean;
}

interface ProjectRole {
	/** The ending of the name of the grant: `<app>-<name>` */
	name: string;
	role: string;
	/** The resource that was the parent of the grant in 1.0.95, if the grant existed then */
	oldParent?: pulumi.Resource;
}

/** The project roles that an app needs for its service account, in the order they are granted */
function appProjectRoles(args: Pick<ServiceIdentityArgs, 'app' | 'database' | 'worker'>): ProjectRole[] {
	const roles: ProjectRole[] = [
		{ name: 'log-writer', role: 'roles/logging.logWriter', oldParent: args.app }
	];

	if (args.database !== undefined) {
		roles.push({ name: 'cloudsql-client', role: 'roles/cloudsql.client', oldParent: args.database });
	}

	if (args.worker) {
		roles.push({ name: 'metric-writer', role: 'roles/monitoring.metricWriter' });
	}

	return(roles);
}

/**
 * The one owner of the service account of an app and of the project roles
 * that it is granted (invariant I-iam-owner). The components of the app
 * (the migration job and the worker) receive it and grant nothing.
 *
 * `changeProjectIAMPolicy` is asked for each role once, here.
 */
export class ServiceIdentity extends pulumi.ComponentResource {
	/** The account of the app: the caller's, or the one created here */
	readonly account: Pick<gcp.serviceaccount.Account, 'email'>;
	readonly email: pulumi.Output<string>;

	/** What the grants of the project roles are (resources, or what `changeProjectIAMPolicy` returned) */
	readonly grants: pulumi.Input<pulumi.Resource>[] = [];

	/** The roles that this identity grants (none when the caller's account is used or `grantRoles` is false) */
	readonly grantedRoles: string[] = [];

	/**
	 * @param name Name of the app: the identity is `${name}-identity`, and
	 * the account and the grants are named `${name}-sa`, `${name}-log-writer`
	 * and so on, as they were in 1.0.95
	 */
	constructor(name: string, args: ServiceIdentityArgs, opts?: pulumi.ComponentResourceOptions) {
		super('Keeta:GCP:ServiceIdentity', `${name}-identity`, {}, opts);

		if (args.account !== undefined) {
			this.account = args.account;
		} else {
			this.account = new gcp.serviceaccount.Account(`${name}-sa`, {
				description: `[${name}] Service account`,
				accountId: generateName(name, 'sa', 30)
			}, {
				parent: this,
				aliases: movedFrom(`${name}-sa`, 'gcp:serviceaccount/account:Account', { kind: 'resource', urn: args.app.urn })
			});
		}

		this.email = pulumi.output(this.account.email);
		const member = pulumi.interpolate`serviceAccount:${this.email}`;

		if (args.grantRoles) {
			for (const { name: grantName, role, oldParent } of appProjectRoles(args)) {
				this.grantedRoles.push(role);

				if (args.gcp.changeProjectIAMPolicy) {
					const policyResource = args.gcp.changeProjectIAMPolicy(role, [ member ]);
					if (policyResource) {
						this.grants.push(policyResource);
					}

					continue;
				}

				const grantResourceName = `${name}-${grantName}`;
				let aliases: pulumi.Output<pulumi.URN>[] | undefined;
				if (oldParent !== undefined) {
					aliases = movedFrom(grantResourceName, 'gcp:projects/iAMMember:IAMMember', { kind: 'resource', urn: oldParent.urn });
				}

				this.grants.push(new gcp.projects.IAMMember(grantResourceName, {
					project: args.gcp.project,
					role,
					member
				}, { parent: this, aliases }));
			}
		}

		this.registerOutputs({ email: this.email });
	}
}
