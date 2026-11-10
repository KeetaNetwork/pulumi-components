import type * as pulumi from '@pulumi/pulumi';

/** Waits for a Pulumi Output to resolve, the way a test needs its value */
export function resolveOutput<Value>(output: pulumi.Output<Value>) {
	return(new Promise<Value>(function(resolve) {
		output.apply(resolve);
	}));
}
