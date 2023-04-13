import { gcpRegions, gcpSpannerRegions, gcpZones, spannerMultiRegionConfiguration } from './constants';
import type * as types from './constants';

export function assertGCPRegion(region: any): types.GCPRegion {
	if (!gcpRegions.includes(region)) {
		throw(new Error(`Region ${region} is not a valid GCP region`));
	}

	return region;
}

export function assertGCPZone(zone: any): types.GCPZone {
	if (typeof zone !== 'string') {
		throw(new Error(`Zone ${zone} is not a string`));
	}

	const maybeRegion = zone.split('-').slice(0, 2).join('-');
	const region = assertGCPRegion(maybeRegion);

	const regionalZones = gcpZones[region];
	if (regionalZones === undefined) {
		throw(new Error(`internal error: Valid region ${region} has no valid zones!`));
	}

	/*
	 * We have verified the zone is a string, and that it is a valid region,
	 * and we are about to verify that it is a valid zone in that region
	 * so we can safely cast it to a GCPZone.
	 */
	// eslint-disable-next-line no-type-assertion/no-type-assertion
	const verifiedZone = zone as types.GCPZone;

	/* TypeScript is confused about the type of regionalZones, so we have to
	 * use a ts-ignore here.
	 */
	// @ts-ignore
	if (!regionalZones.includes(verifiedZone)) {
		throw(new Error(`Zone ${zone} is not a valid GCP zone`));
	}

	return(verifiedZone);
}

export function gcpPrimaryZone(region: string): types.GCPZone {
	const zones = gcpZones[assertGCPRegion(region)];
	if (zones === undefined) {
		throw(new Error(`Invalid region: ${region}`));
	}

	const zone = zones[0];

	return(zone);
}


export function isGCPSpannerRegion(region: any): region is types.GCPSpannerRegion {
	return gcpSpannerRegions.includes(region);
}


export function assertGCPSpannerRegion(region: any): types.GCPSpannerRegion {
	if (!isGCPSpannerRegion(region)) {
		throw new Error(`Invalid spanner region: ${region}`);
	}

	return region;
}

export function isGCPSpannerMultiRegionConfig(input: any): input is types.GCPSpannerMultiRegionConfig {
	return Object.keys(spannerMultiRegionConfiguration).includes(input);
}

export function assertGCPSpannerMultiRegionConfig(input: any): types.GCPSpannerMultiRegionConfig {
	if (!isGCPSpannerMultiRegionConfig(input)) {
		throw new Error(`Invalid Spanner multi-region configuration name: ${input}`);
	}

	return input;
}

export function getGCPSpannerLocationInput(input: types.GCPSpannerMultiRegionConfig | types.GCPSpannerRegion): types.GCPSpannerRegionPrefixed | types.GCPSpannerMultiRegionConfig {
	if (isGCPSpannerMultiRegionConfig(input)) {
		return input;
	}

	if (isGCPSpannerRegion(input)) {
		return(`regional-${input}`);
	}

	throw new Error(`Invalid Spanner configuration input: ${input}`);
}
