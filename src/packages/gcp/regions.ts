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


export function assertGCPSpannerRegion(region: any): types.GCPSpannerRegion {
	if (!gcpSpannerRegions.includes(region)) {
		throw new Error(`Invalid spanner region: ${region}`);
	}

	return region;
}

export function toGCPSpannerRegion(region: string): types.GCPSpannerRegionInput {
	let withoutRegion = region;

	if (withoutRegion.includes('regional-')) {
		withoutRegion = withoutRegion.replace('regional-', '');
	}

	return(`regional-${assertGCPSpannerRegion(withoutRegion)}`);
}

export function assertSpannerMultiRegionRegion(input: any): types.SpannerMultiRegionRegion {
	for (const regions of Object.values(spannerMultiRegionConfiguration)) {
		for (const { region } of regions) {
			if (region === input) {
				return input;
			}
		}
	}

	throw new Error(`Invalid Spanner multi-region region: ${input}`);
}



export function assertSpannerMultiRegionConfigName(input: any): types.SpannerMultiRegionName {
	if (!Object.keys(spannerMultiRegionConfiguration).includes(input)) {
		throw new Error(`Invalid Spanner multi-region configuration name: ${input}`);
	}

	return input;
}

export function assertSpannerMultiRegionInConfig<N extends types.SpannerMultiRegionName, R extends string, T extends types.SpannerConfigRegionType, O extends boolean>(config: N, region: R, type?: T, optional?: O): R extends types.SpannerRegionByNameType<N, T, O> ? R : never {
	assertSpannerMultiRegionRegion(region);

	for (const configRegion of spannerMultiRegionConfiguration[config]) {
		if (type && configRegion.type !== type) {
			throw new Error(`Invalid Spanner multi-region configuration type found (${type}/${configRegion.type}), region: ${region}, config: ${config}`);
		}

		if (optional !== undefined && configRegion.optional !== optional) {
			throw new Error(`Invalid Spanner multi-region configuration optional discrepancy found region: ${region}, config: ${config}`);
		}

		if (region === configRegion.region) {
			// @ts-ignore
			return region;
		}
	}

	throw new Error(`Invalid Spanner multi-region region: ${config} for region: ${region}`);
}
