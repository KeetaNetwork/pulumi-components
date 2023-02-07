import * as command from '@pulumi/command';
import type * as pulumi from '@pulumi/pulumi';

export function makeSleeper(name: string, parent: pulumi.Resource, time: number = 30) {
	return new command.local.Command(name, {
		create: 'sleep 0',
		delete: `sleep ${time}`,
		update: 'sleep 0'
	}, { parent });
}
