import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import * as components from '../../';
import type { GCPCommonOptions } from './common';
import { generateName } from '../../utils';

/**
 * Common options for GCP
 */
interface ContainerMIGCommonOptions {
	gcp: Pick<GCPCommonOptions, 'project' | 'changeProjectIAMPolicy' | 'changeRegistryIAMPolicy'>;
}

/**
 * Create a managed instance group (MIG) for containers
 */
interface ContainerMIGOptions {
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
	common: ContainerMIGCommonOptions;

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
	 * Description to provide to the VMs and to the Managed Instance Group (MIG)
	 */
	description?: pulumi.Input<string>;

	/**
	 * Number of VMs/containers to run (default is 1)
	 */
	count?: pulumi.Input<number>;

	/**
	 * Network Interface parameters
	 */
	networkInterfaces?: NonNullable<ConstructorParameters<typeof gcp.compute.InstanceTemplate>[1]>['networkInterfaces'];

	/**
	 * Container specification, must conform to the GCP Container Spec
	 *    https://cloud.google.com/compute/docs/containers/configuring-options-to-run-containers
	 */
	containerSpec: {
		containers: {
			image: pulumi.Input<string>;
			name: pulumi.Input<string>;
			restartPolicy: 'Always';
			args?: pulumi.Input<string>[] | pulumi.Input<string[]>;
			env?: pulumi.Input<{
				name: pulumi.Input<string>;
				value: pulumi.Input<string>;
			}[]>;
		}[];
	};
}

export class ContainerMIG extends pulumi.ComponentResource {
	private static defaultCOSImage?: ReturnType<typeof gcp.compute.getImage>;

	constructor(name: string, options: ContainerMIGOptions, args?: pulumi.CustomResourceOptions) {
		super('Keeta:GCP:ContainerMIG', name, options, args);

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
		 * The Subnet ID to deploy the managed instance group to
		 */
		const subnetID = pulumi.output(options.subnetwork).apply(function(subnetwork) {
			return(subnetwork.id);
		});

		/**
		 * The Network ID to deploy the managed instance group to
		 */
		const networkID = pulumi.output(options.subnetwork).apply(function(subnetwork) {
			return(subnetwork.network);
		});

		/**
		 * The region to deploy the managed instance group to
		 */
		const region = pulumi.output(options.subnetwork).apply(function(subnetwork) {
			return(subnetwork.region);
		});

		/**
		 * Compute the service account to use
		 */
		const serviceAccount = pulumi.output(options.serviceAccount).apply(function(serviceAccountResolved) {
			if (typeof serviceAccountResolved === 'string') {
				return(pulumi.output(serviceAccountResolved));
			}

			return(serviceAccountResolved.email);
		});

		const instanceTemplate = new gcp.compute.InstanceTemplate(`${name}-mig-template`, {
			machineType: options.machineType ?? 'e2-medium',
			region: region,
			disks: [{
				sourceImage: cosImage,

				/* XXX:TODO: Should the user be allowed to specify this in some way ? */
				diskSizeGb: 50
			}],
			serviceAccount: {
				email: serviceAccount,
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
			networkInterfaces: pulumi.all([options.networkInterfaces, networkID, subnetID]).apply(function([networkInterfaces, networkIDResolved, subnetIDResolved]) {
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
						subnetwork: subnetIDResolved,
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
					spec: options.containerSpec
				}),
				'user-data': '#cloud-config\n' + JSON.stringify({
					'runcmd': [
						'mount --bind /dev/null /usr/sbin/sshd',
						'systemctl disable sshd',
						'systemctl stop sshd',
						'pkill -9 -x sshd'
					]
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
		 * Compute a list of images specified
		 */
		const images = options.containerSpec.containers.map(function(container) {
			return(container.image);
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
				const policyResource = options.common.gcp.changeRegistryIAMPolicy(image, 'read', [pulumi.interpolate`serviceAccount:${serviceAccount}`]);

				if (policyResource) {
					policyChangeToDependOn.push(policyResource);
				}
			}
		} else {
			/**
			 * Grant access to the image to the service account -- this assumes the old
			 * Container Registry and needs to be updated to the Artifact Registry
			 */
			const policyResource = new gcp.storage.BucketIAMMember(`${name}-iam`, {
				bucket: `artifacts.${options.common.gcp.project}.appspot.com`,
				member: pulumi.interpolate`serviceAccount:${serviceAccount}`,
				role: 'roles/storage.objectViewer'
			}, {
				parent: this
			});

			policyChangeToDependOn.push(policyResource);
		}

		/**
		 * Grant project access to write logs
		 */
		if (options.common.gcp.changeProjectIAMPolicy) {
			/**
			 * If a callback was specified, use it to grant permissions to logs/metrics
			 */
			const policyResourceLogging = options.common.gcp.changeProjectIAMPolicy('roles/logging.logWriter', [pulumi.interpolate`serviceAccount:${serviceAccount}`]);
			const policyResourceMetric = options.common.gcp.changeProjectIAMPolicy('roles/monitoring.metricWriter', [pulumi.interpolate`serviceAccount:${serviceAccount}`]);

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
				member: pulumi.interpolate`serviceAccount:${serviceAccount}`,
				role: 'roles/logging.logWriter'
			}, {
				parent: this
			});

			const policyResourceMetric = new gcp.projects.IAMMember(`${name}-iam-metric`, {
				project: options.common.gcp.project,
				member: pulumi.interpolate`serviceAccount:${serviceAccount}`,
				role: 'roles/monitoring.metricWriter'
			}, {
				parent: this
			});

			policyChangeToDependOn.push(policyResourceLogging);
			policyChangeToDependOn.push(policyResourceMetric);
		}

		/**
		 * Base name for the instances
		 */
		const baseInstanceName = generateName(name, 'mig-base', 45);

		/**
		 * Create the instance manager (the resource which constructs the instances from the templates)
		 */
		new gcp.compute.RegionInstanceGroupManager(`${name}-mig`, {
			baseInstanceName: baseInstanceName,
			region: region,
			targetSize: options.count ?? 1,
			updatePolicy: {
				mostDisruptiveAllowedAction: 'REPLACE',
				/*
				 * Because pulling down a new image does not delete the old one,
				 * we must replace the instance every time we update it to
				 * ensure that the disk does not fill up
				 */
				minimalAction: 'REPLACE',
				type: 'PROACTIVE',
				maxUnavailableFixed: pulumi.output(region).apply(function(regionResolvedInput) {
					const regionResolved = components.gcp.regions.assertGCPRegion(regionResolvedInput);
					return(components.gcp.constants.gcpZones[regionResolved].length);
				})
			},
			versions: [{
				instanceTemplate: instanceTemplate.selfLink
			}]
		}, {
			parent: this,
			dependsOn: [
				...policyChangeToDependOn
			]
		});
	}
}
