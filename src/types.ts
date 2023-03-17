import type * as pulumi from '@pulumi/pulumi';

// Either type T by itself, or wrapped in pulumi.Output<T>
// XXX:TODO How is this different from pulumi.Input<T>  ?
export type OutputWrapped<T> = pulumi.Output<T> | T;

export type DeepInput<T> = pulumi.Input<T> | {
	[K in keyof T]: DeepInput<T[K]>;
};

export type UnwrapDeepInput<T> = T extends DeepInput<infer U> ? U : T;

export type DeepOutput<T> = pulumi.Lifted<T>;
