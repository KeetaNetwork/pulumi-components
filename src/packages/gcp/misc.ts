import * as pulumi from '@pulumi/pulumi';
import type * as gcp from '@pulumi/gcp';

export function getServiceAccountMemberID(serviceAccount: gcp.serviceaccount.Account) {
	return(pulumi.interpolate`serviceAccount:${serviceAccount.email}`);
}
