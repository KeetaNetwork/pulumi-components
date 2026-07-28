import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import * as components from '../../';
import type { GCPCommonOptions } from './common';
import { generateName } from '../../utils';

/**
 * Common options for GCP
 */
interface ContainerCommonOptions {
	gcp: Pick<GCPCommonOptions, 'project' | 'changeProjectIAMPolicy' | 'changeRegistryIAMPolicy'>;
}


type ContainerValueInputSupportingSecrets = Omit<gcp.types.input.cloudrunv2.JobTemplateTemplateContainerEnv, 'name'>;

/**
 * Options relevant to all kinds of containers
 */
interface ContainerGenericOptions<SupportSecretRefEnvs extends boolean> {
	/**
	 * Service Account to use for the VMs created to host this VMs
	 */
	serviceAccount: pulumi.Input<gcp.serviceaccount.Account> | pulumi.Input<string>;

	/**
	 * GCP Subnetwork to create these VMs within
	 */
	subnetwork: pulumi.Input<Pick<gcp.compute.Subnetwork, 'id' | 'network' | 'region'>>;

	/**
	 * GCP Options
	 */
	common: ContainerCommonOptions;

	/**
	 * Description to provide to the VMs and to the Managed Instance Group (MIG)
	 */
	description?: pulumi.Input<string>;

	/**
	 * Number of VMs/containers to run (default is 1)
	 */
	count?: pulumi.Input<number>;

	/**
	 * Network tags to apply to the VMs
	 */
	tags?: pulumi.Input<string[]>;

	/**
	 * Container specification, must conform to the GCP Container Spec
	 *    https://cloud.google.com/compute/docs/containers/configuring-options-to-run-containers
	 */
	containerSpec: {
		containers: {
			/**
			 * Artifact Registry to use for the image -- used for
			 * granting access to the image to the service account
			 *
			 * Ignored if `common.gcp.changeRegistryIAMPolicy` is
			 * specified
			 */
			registry?: Pick<gcp.artifactregistry.Repository, 'id'>;
			image: pulumi.Input<string>;
			name: pulumi.Input<string>;
			restartPolicy: 'Always';
			args?: pulumi.Input<string>[] | pulumi.Input<string[]>;
			env?: pulumi.Input<({
				name: pulumi.Input<string>;
			} & (SupportSecretRefEnvs extends true ? ContainerValueInputSupportingSecrets : {
				value: pulumi.Input<string | undefined>;
			}))[]>;
		}[];
	};
}

/**
 * Options for creating a managed instance group (MIG) for containers
 */
interface ContainerMIGOptions extends ContainerGenericOptions<false> {
	/**
	 * Zone to deploy the VMs to -- if this is specified it will create a
	 * zonal instance group manager instead of a regional one
	 */
	zone?: pulumi.Input<string>;

	/**
	* Container OS (COS) Image to use for VMs.
	*
	* Default is the latest stable COS image
	*/
	cosImage?: pulumi.Input<string>;

	/**
	 * Machine Type to use
	 */
	machineType?: pulumi.Input<string>;

	/**
	 * Network Interface parameters
	 */
	networkInterfaces?: NonNullable<ConstructorParameters<typeof gcp.compute.InstanceTemplate>[1]>['networkInterfaces'];

	/**
	 * HTTP Server Port
	 */
	httpPort?: pulumi.Input<number>;

	/**
	 * Enable SSH on the VM -- if this is enabled the container will not be
	 * able to listen on port 22 (since the VM's ssh daemon will already be
	 * listening on that port)
	 *
	 * Default is false
	 */
	enableVMSSH?: boolean;
}

/**
 * Options for creating a Cloud Run Worker Pool (CRWP) for containers
 */
type ContainerCloudRunOptions = ContainerGenericOptions<true> & ({
	/**
	 * Cloud Run Worker Pool instance size
	 */
	size?: {
		/**
		 * Amount of RAM for the container (in MiB)
		 */
		ram?: pulumi.Input<string>;
		/**
		 * Amount of CPU for the container (in cores)
		 */
		cpu?: pulumi.Input<string>;
	}
} | {
	/**
	 * Machine Type to use (provided for compatibility with MIGs) -- if this is specified it will override the size option
	 *
	 * You should use the "size" property instead
	 */
	machineType?: pulumi.Input<string>;
}) & {
	/**
	 * How to deal with egress traffic:
	 *    - vpc: All egress traffic will be routed through the VPC (default)
	 *    - vpc+nat: All egress traffic will be routed through the VPC,
	 *      and Cloud NAT will be created to allow egress to the internet
	 *    - vpc+direct: All egress traffic for non-private IPs will be routed
	 *      directly to the internet, and egress traffic for private IPs will
	 *      be sent over the VPC
	 * This replaces the "networkInterfaces" option from MIGs, since Cloud
	 * Run Worker Pools do not support specifying network interfaces directly.
	 */
	egress?: 'vpc' | 'vpc+nat' | 'vpc+direct';
};


function handleGenericOptions(name: string, options: ContainerGenericOptions<true> | ContainerGenericOptions<false>, parent: pulumi.ComponentResource) {
	if (options.common.gcp.project === undefined) {
		throw(new Error(`GCP project must be specified in options.common.gcp.project`));
	}

	if (options.serviceAccount === undefined) {
		throw(new Error(`GCP service account must be specified in options.serviceAccount`));
	}

	if (options.subnetwork === undefined) {
		throw(new Error(`GCP subnetwork must be specified in options.subnetwork`));
	}

	if (options.containerSpec === undefined) {
		throw(new Error(`Container specification must be specified in options.containerSpec`));
	}

	/**
	 * Compute the service account to use
	 */
	const serviceAccount = options.serviceAccount;
	const serviceAccountEmail = pulumi.output(serviceAccount).apply(function(serviceAccountResolved) {
		if (typeof serviceAccountResolved === 'string') {
			return(pulumi.output(serviceAccountResolved));
		}

		return(serviceAccountResolved.email);
	});

	/**
	 * The Subnet ID to deploy the container to
	 */
	const subnetwork = options.subnetwork;
	const subnetworkID = pulumi.output(options.subnetwork).apply(function(subnetwork) {
		return(subnetwork.id);
	});

	/**
	 * The region to deploy the managed instance group to
	 */
	const region = pulumi.output(options.subnetwork).apply(function(subnetwork) {
		return(subnetwork.region);
	});

	/**
	 * Compute a list of images specified
	 */
	const images = options.containerSpec.containers.map(function(container) {
		return(container.image);
	});

	/**
	 * Compute a list of registry IDs specified, and remove that
	 * from the containerSpec
	 */
	const registries = options.containerSpec.containers.map(function(container) {
		if (container.registry) {
			return(container.registry.id);
		}

		return(pulumi.output(pulumi.output(container.image).apply(function(image) {
			const parts = image.split('/');

			if (parts.length < 3) {
				throw(new Error(`Image ${image} is not in a valid format, got ${parts.length} parts when split on '/', expected at least 3 ${image}`));
			}

			const url = parts[0];
			const dockerPkgDevSuffix = '-docker.pkg.dev';
			if (!url?.endsWith(dockerPkgDevSuffix)) {
				throw(new Error(`Image ${image} is not in a valid format, expected to start with a URL ending with 'docker.pkg.dev', got ${url}`));
			}

			const location = url.substring(0, url.length - dockerPkgDevSuffix.length);
			const project = parts[1];
			const registry = parts[2];

			if (!location || !project || !registry) {
				throw(new Error(`Image ${image} is not in a valid format, expected to be in the format {region}-docker.pkg.dev/{project}/{registry}/{image}, got region=${location}, project=${project}, registry=${registry}`));
			}

			return(`projects/${project}/locations/${location}/repositories/${registry}`);
		})));
	}).filter(function(registry): registry is NonNullable<typeof registry> {
		return(registry !== undefined);
	});

	/*
	 * Grant access to the image to the service account
	 */
	const policyChangeToDependOn: pulumi.Input<pulumi.Resource>[] = [];
	if (options.common.gcp.changeRegistryIAMPolicy) {
		/**
		 * For each image perform a callback to grant access to the image
		 */
		for (const image of images) {
			const policyResource = options.common.gcp.changeRegistryIAMPolicy(image, 'read', [pulumi.interpolate`serviceAccount:${serviceAccountEmail}`]);

			if (policyResource) {
				policyChangeToDependOn.push(policyResource);
			}
		}
	} else {
		/**
		 * Grant access to the image to the service account
		 * to the new Artifact Registry
		 */
		let registryIndex = 0;
		for (const registry of registries) {
			registryIndex++;

			const policyResource = new gcp.artifactregistry.RepositoryIamMember(`${name}-ar-${registryIndex}-iam`, {
				repository: registry,
				member: pulumi.interpolate`serviceAccount:${serviceAccountEmail}`,
				role: 'roles/artifactregistry.reader'
			}, {
				parent: parent,
				deleteBeforeReplace: true
			});
			policyChangeToDependOn.push(policyResource);
		}
	}

	/**
	 * Grant project access to write logs
	 */
	if (options.common.gcp.changeProjectIAMPolicy) {
		/**
		 * If a callback was specified, use it to grant permissions to logs/metrics
		 */
		const policyResourceLogging = options.common.gcp.changeProjectIAMPolicy('roles/logging.logWriter', [pulumi.interpolate`serviceAccount:${serviceAccountEmail}`]);
		const policyResourceMetric = options.common.gcp.changeProjectIAMPolicy('roles/monitoring.metricWriter', [pulumi.interpolate`serviceAccount:${serviceAccountEmail}`]);

		if (policyResourceLogging) {
			policyChangeToDependOn.push(policyResourceLogging);
		}

		if (policyResourceMetric) {
			policyChangeToDependOn.push(policyResourceMetric);
		}
	} else {
		/**
		 * Grant project access to write logs/metrics
		 */
		const policyResourceLogging = new gcp.projects.IAMMember(`${name}-iam-logging`, {
			project: options.common.gcp.project,
			member: pulumi.interpolate`serviceAccount:${serviceAccountEmail}`,
			role: 'roles/logging.logWriter'
		}, {
			parent: parent
		});

		const policyResourceMetric = new gcp.projects.IAMMember(`${name}-iam-metric`, {
			project: options.common.gcp.project,
			member: pulumi.interpolate`serviceAccount:${serviceAccountEmail}`,
			role: 'roles/monitoring.metricWriter'
		}, {
			parent: parent
		});

		policyChangeToDependOn.push(policyResourceLogging);
		policyChangeToDependOn.push(policyResourceMetric);
	}

	return({
		subnetwork,
		subnetworkID,
		serviceAccount,
		serviceAccountEmail,
		region,
		registries,
		images,
		policyChangeToDependOn
	});
}

export class ContainerMIG extends pulumi.ComponentResource {
	private static defaultCOSImage?: ReturnType<typeof gcp.compute.getImage>;
	instanceGroupManager: gcp.compute.RegionInstanceGroupManager | gcp.compute.InstanceGroupManager;
	subnetwork: ContainerMIGOptions['subnetwork'];
	serviceAccount: ContainerMIGOptions['serviceAccount'];
	readonly type = 'MIG' as const;

	constructor(name: string, options: ContainerMIGOptions, args?: pulumi.CustomResourceOptions) {
		super('Keeta:GCP:ContainerMIG', name, options, args);

		const {
			subnetwork,
			subnetworkID,
			serviceAccount,
			serviceAccountEmail,
			region,
			policyChangeToDependOn
		} = handleGenericOptions(name, options, this);

		this.subnetwork = subnetwork;
		this.serviceAccount = serviceAccount;

		/**
		 * The "Container OS" image to use for the instances, if not
		 * specified the latest stable version will be used
		 */
		let cosImage: pulumi.Output<string>;

		if (options.cosImage === undefined) {
			/**
			 * Get the COS image to use for instances within the
			 * managed instance groups -- we want this to be done
			 * only once per invocation so that all regions use the
			 * same value
			 */
			if (!ContainerMIG.defaultCOSImage) {
				ContainerMIG.defaultCOSImage = gcp.compute.getImage({
					family: 'cos-stable',
					project: 'cos-cloud'
				});
			}
			/**
			 * The resolved Container OS image ID to use for containers
			 */
			cosImage = pulumi.output(ContainerMIG.defaultCOSImage).apply(function(cosImageInfo) {
				return(cosImageInfo.id);
			});
		} else {
			cosImage = pulumi.output(options.cosImage);
		}

		/**
		 * The short name of the Container OS image
		 */
		const cosImageShortName = cosImage.apply(function(cosImageString) {
			return(cosImageString.split('/').slice(-1)[0]);
		});

		/**
		 * The Network ID to deploy the managed instance group to
		 */
		const networkID = pulumi.output(subnetwork).apply(function(subnetworkResolved) {
			return(subnetworkResolved.network);
		});

		/**
		 * Remove the registry from the container spec
		 */
		const containerSpec = {
			...options.containerSpec,
			containers: options.containerSpec.containers.map(function(container) {
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
				const { registry: _ignore_registry, ...newContainerSpec } = container;
				return(newContainerSpec);
			})
		};

		/**
		 * Run commands to execute on the VMs when they start up
		 */
		const runCommands: string[] = [];
		if (options.enableVMSSH !== true) {
			/*
			 * Disable SSH on the VM (unless the user has explicitly
			 * requested it)
			 */
			runCommands.push('mount --bind /dev/null /usr/sbin/sshd');
			runCommands.push('systemctl disable sshd');
			runCommands.push('systemctl stop sshd');
			runCommands.push('pkill -9 -x sshd');
		}

		/**
		 * Create the Managed Instance Group Template, from which each instance will be created
		 */
		const instanceTemplate = new gcp.compute.InstanceTemplate(`${name}-mig-template`, {
			machineType: options.machineType ?? 'e2-medium',
			region: region,
			tags: options.tags,
			disks: [{
				sourceImage: cosImage,

				/* XXX:TODO: Should the user be allowed to specify this in some way ? */
				diskSizeGb: 50
			}],
			serviceAccount: {
				email: serviceAccountEmail,
				scopes: [
					/* XXX:TODO: Should the user be allowed to specify this in some way ? */
					'https://www.googleapis.com/auth/cloud-platform',
					'https://www.googleapis.com/auth/compute',
					'https://www.googleapis.com/auth/devstorage.read_only',
					'https://www.googleapis.com/auth/logging.write',
					'https://www.googleapis.com/auth/monitoring.write',
					'https://www.googleapis.com/auth/servicecontrol',
					'https://www.googleapis.com/auth/service.management.readonly'
				]
			},
			networkInterfaces: pulumi.all([options.networkInterfaces, networkID, subnetworkID]).apply(function([networkInterfaces, networkIDResolved, subnetworkIDResolved]) {
				if (networkInterfaces === undefined) {
					networkInterfaces = [];
				} else {
					/*
					 * Because we may mutate this, make a copy
					 */
					networkInterfaces = [ ...networkInterfaces ];
				}

				if (networkInterfaces.length === 0) {
					networkInterfaces.push({});
				}

				const interfaces: NonNullable<typeof networkInterfaces> = [
					{
						network: networkIDResolved,
						subnetwork: subnetworkIDResolved,
						accessConfigs: [],
						...networkInterfaces[0]
					}
				];

				interfaces.push(...networkInterfaces.slice(1));

				return(interfaces);
			}),
			metadata: {
				/*
				 * Container Specification for the container
				 */
				'gce-container-declaration': pulumi.jsonStringify({
					spec: containerSpec
				}),
				'user-data': '#cloud-config\n' + JSON.stringify({
					'runcmd': runCommands
				}),
				'google-logging-enabled': 'true',
				'block-project-ssh-keys': 'TRUE'
			},
			labels: {
				'container-vm': cosImageShortName
			}
		}, {
			parent: this
		});

		/**
		 * Base name for the instances
		 */
		const baseInstanceName = generateName(name, 'mig-base', 45);

		/*
		 * Create the instance manager (the resource which constructs the instances from the templates)
		 */
		const igmBaseArgs = {
			baseInstanceName: baseInstanceName,
			targetSize: options.count ?? 1,
			namedPorts: [{
				name: 'http',
				port: options.httpPort ?? 8080
			}],
			updatePolicy: {
				mostDisruptiveAllowedAction: 'REPLACE',
				/*
				 * Because pulling down a new image does not delete the old one,
				 * we must replace the instance every time we update it to
				 * ensure that the disk does not fill up
				 */
				minimalAction: 'REPLACE',
				type: 'PROACTIVE'
			},
			versions: [{
				instanceTemplate: instanceTemplate.selfLink
			}]
		} satisfies Omit<ConstructorParameters<typeof gcp.compute.RegionInstanceGroupManager>[1], 'region'> | Omit<ConstructorParameters<typeof gcp.compute.InstanceGroupManager>[1], 'zone'>;

		let igm: gcp.compute.RegionInstanceGroupManager | gcp.compute.InstanceGroupManager;
		if ('zone' in options) {
			igm = new gcp.compute.InstanceGroupManager(`${name}-mig`, {
				...igmBaseArgs,
				zone: options.zone,
				updatePolicy:{
					...igmBaseArgs.updatePolicy,
					maxUnavailablePercent: 100
				}
			}, {
				parent: this,
				dependsOn: [
					...policyChangeToDependOn
				]
			});
		} else {
			igm = new gcp.compute.RegionInstanceGroupManager(`${name}-mig`, {
				...igmBaseArgs,
				region: region,
				updatePolicy: {
					...igmBaseArgs.updatePolicy,
					maxUnavailableFixed: pulumi.output(region).apply(function(regionResolvedInput) {
						const regionResolved = components.gcp.regions.assertGCPRegion(regionResolvedInput);
						return(components.gcp.constants.gcpZones[regionResolved].length);
					})
				}
			}, {
				parent: this,
				dependsOn: [
					...policyChangeToDependOn
				]
			});
		}

		this.instanceGroupManager = igm;
	}
}

export class ContainerCloudRun extends pulumi.ComponentResource {
	subnetwork: ContainerCloudRunOptions['subnetwork'];
	serviceAccount: ContainerCloudRunOptions['serviceAccount'];
	workerPool: gcp.cloudrunv2.WorkerPool;
	cloudNAT?: {
		router: gcp.compute.Router;
		nat: gcp.compute.RouterNat;
	};

	readonly type = 'CloudRun' as const;

	constructor(name: string, options: ContainerCloudRunOptions, args?: pulumi.CustomResourceOptions) {
		super('Keeta:GCP:ContainerCloudRun', name, options, args);

		const {
			subnetwork,
			subnetworkID,
			serviceAccount,
			serviceAccountEmail,
			region,
			policyChangeToDependOn
		} = handleGenericOptions(name, options, this);

		this.subnetwork = subnetwork;
		this.serviceAccount = serviceAccount;

		const toDependOn: pulumi.Resource[] = [];
		if (options.egress === 'vpc+nat') {
			const networkID = pulumi.output(subnetwork).apply(function(subnetworkResolved) {
				return(subnetworkResolved.network);
			});

			const router = new gcp.compute.Router(`${name}-cloudnat-router`, {
				description: `[${name}] Cloud NAT router for Cloud Run Worker Pool`,
				network: networkID,
				region: region
			}, {
				parent: this
			});

			const nat = new gcp.compute.RouterNat(`${name}-cloudnat`, {
				router: router.name,
				region: region,
				natIpAllocateOption: 'AUTO_ONLY',
				sourceSubnetworkIpRangesToNat: 'ALL_SUBNETWORKS_ALL_IP_RANGES'
			}, {
				parent: this
			});

			new gcp.compute.Route(`${name}-nat-default-route`, {
				network: networkID,
				destRange: "0.0.0.0/0",
				nextHopGateway: "default-internet-gateway",
				priority: 1000
			}, {
				parent: this,
				retainOnDelete: true,
				dependsOn: [nat]
			});

			this.cloudNAT = {
				router: router,
				nat: nat
			};

			toDependOn.push(router);
			toDependOn.push(nat);
		}

		/*
		 * Define the CPU and RAM based in the input either as machine-type or size
		 */
		let cpuCount: pulumi.Input<string> | undefined;
		let ramSize: pulumi.Input<string> | undefined;
		if ('machineType' in options && options.machineType !== undefined) {
			cpuCount = pulumi.output(options.machineType).apply(function(machineType) {
				switch (machineType) {
					case 'e2-micro':
						return('1');
					case 'e2-small':
						return('2');
					case 'e2-medium':
						return('2');
					case 'e2-standard-2':
						return('2');
					case 'e2-standard-4':
						return('4');
					default:
						throw(new Error(`Machine type ${machineType} is not supported for Cloud Run Worker Pools -- please add it to the CPU detector`));
				}
			});

			/* In MiB */
			ramSize = pulumi.output(options.machineType).apply(function(machineType) {
				switch (machineType) {
					case 'e2-micro':
						return('1024');
					case 'e2-small':
						return('2048');
					case 'e2-medium':
						return('4096');
					case 'e2-standard-2':
						return('8192');
					case 'e2-standard-4':
						return('16384');
					default:
						throw(new Error(`Machine type ${machineType} is not supported for Cloud Run Worker Pools -- please add it to the RAM detector`));
				}
			});
		}
		if ('size' in options && options.size !== undefined) {
			if (options?.size?.cpu !== undefined) {
				cpuCount = options.size.cpu;
			}
			if (options?.size?.ram !== undefined) {
				ramSize = options.size.ram;
			}
		}
		if (cpuCount === undefined) {
			cpuCount = '2';
		}
		if (ramSize === undefined) {
			ramSize = '4096';
		}

		/**
		 * Determine VPC Access type
		 */
		let vpcAccessType: pulumi.Input<'PRIVATE_RANGES_ONLY' | 'ALL_TRAFFIC'> = 'ALL_TRAFFIC';
		if (options.egress === 'vpc+direct') {
			vpcAccessType = 'PRIVATE_RANGES_ONLY';
		}

		const workerPool = new gcp.cloudrunv2.WorkerPool(`${name}-pool`, {
			location: region,
			template: {
				containers: options.containerSpec.containers.map(function(container) {
					return({
						name: container.name,
						image: container.image,
						args: container.args,
						envs: container.env,
						resources: {
							limits: {
								cpu: cpuCount,
								memory: pulumi.interpolate`${ramSize}Mi`
							}
						}
					});
				}),
				serviceAccount: serviceAccountEmail,
				vpcAccess: {
					networkInterfaces: [{
						subnetwork: subnetworkID,
						tags: options.tags
					}],
					egress: vpcAccessType
				}
			},
			scaling: {
				manualInstanceCount: options.count ?? 1
			},
			deletionProtection: false,
			deletionPolicy: 'DELETE'
		}, {
			parent: this,
			dependsOn: [...policyChangeToDependOn.splice(0), ...toDependOn.splice(0)]
		});

		this.workerPool = workerPool;
	}
}

export type ContainerGeneric = InstanceType<typeof ContainerMIG> | InstanceType<typeof ContainerCloudRun>;
