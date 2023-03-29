import { gcpRegions, gcpZones } from './constants';
import type { GCPRegion, GCPZone } from './constants';

export function assertGCPRegion(region: any): GCPRegion {
	if (!gcpRegions.includes(region)) {
		throw(new Error(`Region ${region} is not a valid GCP region`));
	}

	return region;
}

export function assertGCPZone(zone: any): GCPZone {
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
	const verifiedZone = zone as GCPZone;

	/* TypeScript is confused about the type of regionalZones, so we have to
	 * use a ts-ignore here.
	 */
	// @ts-ignore
	if (!regionalZones.includes(verifiedZone)) {
		throw(new Error(`Zone ${zone} is not a valid GCP zone`));
	}

	return(verifiedZone);
}

export function gcpPrimaryZone(region: string): GCPZone {
	const zones = gcpZones[assertGCPRegion(region)];
	if (zones === undefined) {
		throw(new Error(`Invalid region: ${region}`));
	}

	const zone = zones[0];

	return(zone);
}
