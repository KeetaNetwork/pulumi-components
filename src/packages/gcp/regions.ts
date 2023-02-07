import { gcpRegions } from './constants';

export type GcpRegionName = typeof gcpRegions[any];

export function SpannerConfigFromRegion(region: GcpRegionName) {
	return(`regional-${region}`);
}

export function assertGCPRegion(region: any): asserts region is GcpRegionName {
	if (!gcpRegions.includes(region)) {
		throw(new Error(`Region ${region} is not a valid GCP region`));
	}
}
