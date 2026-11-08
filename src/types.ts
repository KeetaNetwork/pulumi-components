import type * as pulumi from '@pulumi/pulumi';

export type DeepInput<T> = pulumi.Input<T> | {
	[K in keyof T]: DeepInput<T[K]>;
};

export type UnwrapDeepInput<T> = T extends DeepInput<infer U> ? U : T;

export type DeepOutput<T> = pulumi.Lifted<T>;
