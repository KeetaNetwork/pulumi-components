import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { gcp as gcpComponents } from '@keetanetwork/pulumi-components';

const gcpProject = gcp.config.project ?? process.env.GOOGLE_PROJECT ?? process.env.GCLOUD_PROJECT;
if (!gcpProject) {
	throw new Error('GCP project not configured');
}

const region: gcpComponents.constants.GCPRegion = 'us-central1';
const stack = pulumi.getStack();
const name = `cm-test-${stack}`.substring(0, 25);

const network = new gcp.compute.Network(`${name}-vpc`, {
	autoCreateSubnetworks: false
});

const subnet = new gcp.compute.Subnetwork(`${name}-subnet`, {
	network: network.selfLink,
	region: region,
	ipCidrRange: '10.0.0.0/24',
	privateIpGoogleAccess: true
});

const serviceAccount = new gcp.serviceaccount.Account(`${name}-sa`, {
	accountId: name
});

// Remote repository proxying Docker Hub -- gives a public image an Artifact Registry URI
const registry = new gcp.artifactregistry.Repository(`${name}-repo`, {
	location: region,
	repositoryId: `${name}-repo`.substring(0, 25),
	format: 'DOCKER',
	mode: 'REMOTE_REPOSITORY',
	remoteRepositoryConfig: {
		dockerRepository: {
			publicRepository: 'DOCKER_HUB'
		}
	}
});

const image = pulumi.interpolate`${region}-docker.pkg.dev/${gcpProject}/${registry.repositoryId}/library/busybox:stable`;

const markerValue = `cm-${stack}`;
const multiLineValue = 'first line\nsecond line';

export const mig = new gcpComponents.container.ContainerMIG(name, {
	description: `[${name}] ContainerMIG example`,
	serviceAccount: serviceAccount,
	subnetwork: subnet,
	machineType: 'e2-micro',
	count: 1,
	common: {
		gcp: {
			project: gcpProject
		}
	},
	containerSpec: {
		containers: [{
			image: image,
			name: `${name}-heartbeat`,
			restartPolicy: 'Always',
			args: ['sh', '-c', 'while true; do echo "marker=$MARKER lines=$(printf \'%s\\n\' "$MULTI" | wc -l | tr -d \' \')"; sleep 10; done'],
			env: [
				{ name: 'MARKER', value: markerValue },
				{ name: 'MULTI', value: multiLineValue }
			]
		}]
	}
});

export const project = gcpProject;
export const migName = mig.instanceGroupManager.name;
export const migRegion = region;
export const marker = markerValue;
