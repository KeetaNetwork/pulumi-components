import * as pulumi from '@pulumi/pulumi';
import * as gcpLegacy from '@pulumi/gcp';

import * as utils from '../../utils';

export interface PolicyDataBinding {
	type: 'bucket' | 'project' | 'keyring' | 'key' | 'config';
	name: pulumi.Input<string>;
	id: string;
	policyData: pulumi.Output<string>;
	addMembers(role: string, members: pulumi.Input<string>[]): void;
}

export class PolicyBindingBase {
	private members: { [role: string]: pulumi.Input<string>[] } = {};

	addMembers(role: string, members: pulumi.Input<string>[]) {
		if (!(role in this.members)) {
			this.members[role] = [];
		}
		const roleMembers = this.members[role];
		roleMembers.push(...members);
	}

	get policyData() {
		return(pulumi.jsonStringify({
			bindings: Object.entries(this.members).map(function([role, members]) {
				return({ role, members });
			})
		}));
	}
}

export class BucketPolicyBinding extends PolicyBindingBase implements PolicyDataBinding {
	readonly type = 'bucket';
	readonly id: string;
	readonly name: pulumi.Input<string>;
	readonly bucket?: gcpLegacy.storage.Bucket;
	private static cachedBuckets: { [bucketName: string]: BucketPolicyBinding } = {};
	private static cachedBucketResources: { [resourceName: string]: BucketPolicyBinding } = {};

	constructor(resourceId: string, resourceName: pulumi.Input<string>, bucket?: gcpLegacy.storage.Bucket) {
		super();

		this.id = resourceId;
		this.name = resourceName;
		this.bucket = bucket;
	}

	static fromBucketName(bucketName: string) {
		if (bucketName in this.cachedBuckets) {
			return(this.cachedBuckets[bucketName]);
		}

		this.cachedBuckets[bucketName] = new BucketPolicyBinding(bucketName, bucketName);

		return(this.cachedBuckets[bucketName]);
	}

	static createBucket(...args: ConstructorParameters<typeof gcpLegacy.storage.Bucket>) {
		const resourceName = args[0];
		if (resourceName in this.cachedBucketResources) {
			return(this.cachedBucketResources[resourceName]);
		}

		const bucket = new gcpLegacy.storage.Bucket(...args);
		const retval = new BucketPolicyBinding(resourceName, bucket.name, bucket);

		this.cachedBucketResources[resourceName] = retval;

		return(this.cachedBucketResources[resourceName]);
	}
}

type IAMAuditConfig = Omit<ConstructorParameters<typeof gcpLegacy.projects.IAMAuditConfig>[1], 'project'>;
export class ProjectPolicyBinding extends PolicyBindingBase implements PolicyDataBinding {
	readonly type = 'project';
	readonly id: string;
	readonly name: string;
	private auditConfigs?: IAMAuditConfig[];
	private static cachedProjects: { [projectName: string]: ProjectPolicyBinding } = {};

	constructor(projectName: string) {
		super();

		this.id = projectName;
		this.name = projectName;
	}

	addAuditConfig(config: IAMAuditConfig) {
		if (this.auditConfigs === undefined) {
			this.auditConfigs = [];
		}

		this.auditConfigs.push({ ...config });
	}

	static fromProjectName(projectName: string) {
		if (projectName in this.cachedProjects) {
			return(this.cachedProjects[projectName]);
		}

		this.cachedProjects[projectName] = new ProjectPolicyBinding(projectName);

		return(this.cachedProjects[projectName]);
	}

	get policyData() {
		const basePolicyDataWrapper = super.policyData;

		if (this.auditConfigs === undefined) {
			return(basePolicyDataWrapper);
		}

		const policyData = basePolicyDataWrapper.apply((basePolicyDataString) => {
			if (this.auditConfigs === undefined) {
				return(basePolicyDataString);
			}

			const basePolicyData = JSON.parse(basePolicyDataString);

			basePolicyData.auditConfigs = this.auditConfigs;

			return(JSON.stringify(basePolicyData));
		});

		return(policyData);
	}
}

export class KeyRingPolicyBinding extends PolicyBindingBase implements PolicyDataBinding {
	readonly type = 'keyring';
	readonly id: string;
	readonly name: pulumi.Input<string>;
	readonly keyring: gcpLegacy.kms.KeyRing;
	private static cachedKeyRingsByID: { [keyringID: string]: KeyRingPolicyBinding } = {};

	constructor(resourceId: string, resourceName: pulumi.Input<string>, keyring: gcpLegacy.kms.KeyRing) {
		super();

		this.id = resourceId;
		this.name = resourceName;
		this.keyring = keyring;
	}

	static createKeyRing(...args: ConstructorParameters<typeof gcpLegacy.kms.KeyRing>) {
		const resourceName = args[0];
		if (resourceName in this.cachedKeyRingsByID) {
			return(this.cachedKeyRingsByID[resourceName]);
		}

		const keyring = new gcpLegacy.kms.KeyRing(...args);
		const retval = new KeyRingPolicyBinding(resourceName, keyring.name, keyring);

		this.cachedKeyRingsByID[resourceName] = retval;

		return(this.cachedKeyRingsByID[resourceName]);
	}
}

export class KeyPolicyBinding extends PolicyBindingBase implements PolicyDataBinding {
	readonly type = 'key';
	readonly id: string;
	readonly name: pulumi.Input<string>;
	readonly key: gcpLegacy.kms.CryptoKey;
	private static cachedKeysByID: { [keyringID: string]: KeyPolicyBinding } = {};

	constructor(resourceId: string, resourceName: pulumi.Input<string>, key: gcpLegacy.kms.CryptoKey) {
		super();

		this.id = resourceId;
		this.name = resourceName;
		this.key = key;
	}

	static createKey(...args: ConstructorParameters<typeof gcpLegacy.kms.CryptoKey>) {
		const resourceName = args[0];
		if (resourceName in this.cachedKeysByID) {
			return(this.cachedKeysByID[resourceName]);
		}

		const key = new gcpLegacy.kms.CryptoKey(...args);
		const retval = new KeyPolicyBinding(resourceName, key.name, key);

		this.cachedKeysByID[resourceName] = retval;

		return(this.cachedKeysByID[resourceName]);
	}
}

export class ConfigPolicyBinding extends PolicyBindingBase implements PolicyDataBinding {
	readonly type = 'config';
	readonly id: string;
	readonly name: pulumi.Input<string>;
	readonly config: gcpLegacy.runtimeconfig.Config;

	constructor(resourceId: string, resourceName: pulumi.Input<string>, config: gcpLegacy.runtimeconfig.Config) {
		super();

		this.id = resourceId;
		this.name = resourceName;
		this.config = config;
	}

	static createConfig(...args: ConstructorParameters<typeof gcpLegacy.runtimeconfig.Config>) {
		const resourceName = args[0];
		const config = new gcpLegacy.runtimeconfig.Config(...args);
		const retval = new ConfigPolicyBinding(resourceName, config.name, config);
		return(retval);
	}
}

type ApplyBindingsOptions = (NonNullable<ConstructorParameters<typeof gcpLegacy.storage.BucketIAMPolicy>[2]> & { allowProject?: boolean }) | undefined;
export function applyBindings(bindings: PolicyDataBinding[], options: ApplyBindingsOptions) {
	options = {
		allowProject: false,
		...options
	};
	const allowProject = options.allowProject;
	delete options['allowProject'];

	const seenIDs = new Set<string>();
	for (const binding of bindings) {
		const { type, id, name, policyData } = binding;
		if (seenIDs.has(id)) {
			continue;
		}
		seenIDs.add(id);

		const policyResourceName = `policy-${type}-${utils.hash(id)}`;

		switch (type) {
			case 'bucket':
				new gcpLegacy.storage.BucketIAMPolicy(policyResourceName, {
					bucket: name,
					policyData: policyData
				}, options);
				break;
			case 'project':
				if (!allowProject) {
					throw(new Error('Tried to set Project policy (dangerous!)'));
				}

				new gcpLegacy.projects.IAMPolicy(policyResourceName, {
					project: name,
					policyData: policyData
				}, {
					protect: true,
					...options
				});
				break;
			case 'keyring':
				{
					if (!(binding instanceof KeyRingPolicyBinding)) {
						throw(new Error('internal error: mismatch between type and object'));
					}

					const project = binding.keyring.project;
					const location = binding.keyring.location;

					new gcpLegacy.kms.KeyRingIAMPolicy(policyResourceName, {
						keyRingId: pulumi.interpolate`${project}/${location}/${name}`,
						policyData: policyData
					}, options);
				}
				break;
			case 'key':
				{
					if (!(binding instanceof KeyPolicyBinding)) {
						throw(new Error('internal error: mismatch between type and object'));
					}

					const keyRingFQNWrapper = binding.key.keyRing;

					const keyRingPath = keyRingFQNWrapper.apply(function(keyRingFQN) {
						const parts = keyRingFQN.split('/');
						const project = parts[1];
						const location = parts[3];
						const keyring = parts[5];

						return(`${project}/${location}/${keyring}`);
					});

					new gcpLegacy.kms.CryptoKeyIAMPolicy(policyResourceName, {
						cryptoKeyId: pulumi.interpolate`${keyRingPath}/${name}`,
						policyData: policyData
					}, options);
				}
				break;
			case 'config':
				new gcpLegacy.runtimeconfig.ConfigIamPolicy(policyResourceName, {
					config: name,
					policyData: policyData
				}, options);
				break;
		}
	}
}
