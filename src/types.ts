
import type * as pulumi from '@pulumi/pulumi';

// Either type T by itself, or wrapped in pulumi.Output<T>
export type OutputWrapped<T> = pulumi.Output<T> | T;
