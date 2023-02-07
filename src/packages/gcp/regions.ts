import { gcpRegions } from './constants';

export type GcpRegionName = typeof gcpRegions[any];

export function assertGCPRegion(region: any): GcpRegionName {
	if (!gcpRegions.includes(region)) {
		throw(new Error(`Region ${region} is not a valid GCP region`));
	}

	return region;
}
