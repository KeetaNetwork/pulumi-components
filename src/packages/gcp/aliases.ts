import * as pulumi from '@pulumi/pulumi';

/**
 * Where a resource was created in 1.0.95, as far as its URN is concerned:
 * at the root of the stack, or under a resource (given by its URN, which for
 * a parent that moved too is its own `legacyUrn`, never the resource itself).
 */
export type OldParent = {
	kind: 'stack';
} | {
	kind: 'resource';
	urn: pulumi.Input<pulumi.URN>;
};

/**
 * The URN that a resource had before it moved to another parent. A resource
 * that sat at the root of the stack gets its URN built without a parent.
 * Every move uses this one alias form, an exact URN, so the baseline test
 * compares each alias string for string with the URNs of 1.0.95.
 */
export function legacyUrn(name: string, type: string, oldParent: OldParent): pulumi.Output<pulumi.URN> {
	if (oldParent.kind === 'stack') {
		return(pulumi.createUrn(name, type));
	}

	return(pulumi.createUrn(name, type, oldParent.urn));
}

/**
 * The `aliases` option of a resource that moved: exactly one alias, the URN
 * it had under its old parent.
 */
export function movedFrom(name: string, type: string, oldParent: OldParent): pulumi.Output<pulumi.URN>[] {
	return([ legacyUrn(name, type, oldParent) ]);
}
