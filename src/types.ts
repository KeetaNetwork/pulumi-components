
import type * as pulumi from '@pulumi/pulumi';

// Either type T by itself, or wrapped in pulumi.Output<T>
export type OutputWrapped<T> = pulumi.Output<T> | T;

export type DeepInput<T> = pulumi.Input<T> | {
	[K in keyof T]: DeepInput<T[K]>;
};
