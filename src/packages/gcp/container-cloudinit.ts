export const CONTAINER_UNIT_NAME = 'container.service';

/**
 * On the stateful partition -- the root filesystem is read-only on COS
 */
export const CONTAINER_STATE_DIR = '/var/lib/container';

const RUN_SCRIPT_PATH = `${CONTAINER_STATE_DIR}/run.sh`;
const UNIT_PATH = `/etc/systemd/system/${CONTAINER_UNIT_NAME}`;

/**
 * Quote a value as a single literal word for a POSIX shell
 */
export function shellQuote(value: string): string {
	return('\'' + value.replace(/'/g, '\'\\\'\'') + '\'');
}

/**
 * Restrict a name to characters valid for docker and safe unquoted in a systemd unit
 */
export function sanitizeContainerName(name: string): string {
	return(name.replace(/[^A-Za-z0-9_.-]/g, '-'));
}

export interface ContainerCloudConfigInput {
	image: string;
	name: string;
	args: string[];
	env: { name: string; value: string | undefined }[];
	runCommands: string[];
}

export interface CloudConfig {
	write_files: {
		path: string;
		permissions: string;
		content: string;
	}[];
	runcmd: string[];
}

function buildRunScript(input: ContainerCloudConfigInput, containerName: string): string {
	const registryHost = input.image.split('/')[0];

	const runArguments = [
		'--rm',
		`--name=${shellQuote(containerName)}`,
		'--network=host',
		'--log-driver=gcplogs'
	];

	for (const envVar of input.env) {
		const assignment = `${envVar.name}=${envVar.value ?? ''}`;
		runArguments.push(`-e ${shellQuote(assignment)}`);
	}

	runArguments.push(shellQuote(input.image));

	for (const arg of input.args) {
		runArguments.push(shellQuote(arg));
	}

	const lines = [
		'#!/bin/sh',
		'set -e',
		`/usr/bin/docker-credential-gcr configure-docker --registries=${registryHost}`,
		`/usr/bin/docker pull ${shellQuote(input.image)}`,
		'exec /usr/bin/docker run \\',
		...runArguments.map(function(argument, index) {
			const continuation = index < runArguments.length - 1 ? ' \\' : '';
			return(`\t${argument}${continuation}`);
		}),
		''
	];

	return(lines.join('\n'));
}

function buildUnit(containerName: string): string {
	const lines = [
		'[Unit]',
		'Description=Container from instance metadata (ContainerMIG)',
		'After=docker.service network-online.target',
		'Requires=docker.service',
		'',
		'[Service]',
		`Environment=HOME=${CONTAINER_STATE_DIR}`,
		`Environment=DOCKER_CONFIG=${CONTAINER_STATE_DIR}/.docker`,
		'StandardOutput=journal+console',
		'StandardError=journal+console',
		`ExecStartPre=-/usr/bin/docker rm -f ${containerName}`,
		`ExecStart=/bin/sh ${RUN_SCRIPT_PATH}`,
		`ExecStop=-/usr/bin/docker stop ${containerName}`,
		'Restart=always',
		'RestartSec=5',
		''
	];

	return(lines.join('\n'));
}

/**
 * Build the cloud-config which runs a container on COS (replaces the
 * container startup agent)
 */
export function buildContainerCloudConfig(input: ContainerCloudConfigInput): CloudConfig {
	const containerName = sanitizeContainerName(input.name);

	const runcmd = [...input.runCommands];

	/*
	 * COS drops inbound traffic by default; the container startup agent
	 * opened the host firewall on every boot, so do the same
	 */
	for (const protocol of ['tcp', 'udp', 'icmp']) {
		for (const chain of ['INPUT', 'FORWARD']) {
			runcmd.push(`iptables -w -A ${chain} -p ${protocol} -j ACCEPT`);
		}
	}

	/*
	 * Not "enable": /etc is stateless on COS and cloud-init re-runs this on every boot
	 */
	runcmd.push('systemctl daemon-reload');
	runcmd.push(`systemctl start ${CONTAINER_UNIT_NAME}`);

	return({
		write_files: [
			{
				path: RUN_SCRIPT_PATH,
				permissions: '0755',
				content: buildRunScript(input, containerName)
			},
			{
				path: UNIT_PATH,
				permissions: '0644',
				content: buildUnit(containerName)
			}
		],
		runcmd: runcmd
	});
}
