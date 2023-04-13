import { COMPONENT_PREFIX } from '../../constants';

export const GCP_COMPONENT_PREFIX = `${COMPONENT_PREFIX}:GCP` as const;

export const gcpRegions = [
	'asia-east1',
	'asia-east2',
	'asia-northeast1',
	'asia-northeast2',
	'asia-northeast3',
	'asia-south1',
	'asia-south2',
	'asia-southeast1',
	'asia-southeast2',
	'australia-southeast1',
	'australia-southeast2',
	'europe-central2',
	'europe-north1',
	'europe-southwest1',
	'europe-west1',
	'europe-west2',
	'europe-west3',
	'europe-west4',
	'europe-west6',
	'europe-west8',
	'europe-west9',
	'me-west1',
	'northamerica-northeast1',
	'northamerica-northeast2',
	'southamerica-east1',
	'southamerica-west1',
	'us-central1',
	'us-east1',
	'us-east4',
	'us-east5',
	'us-south1',
	'us-west1',
	'us-west2',
	'us-west3',
	'us-west4'
] as const;
export type GCPRegion = typeof gcpRegions[number];

/**
 * Zones for each GCP Region for Google Compute Engine
 * From: https://cloud.google.com/compute/docs/regions-zones
 */
export const gcpZones = {
	'asia-east1': ['asia-east1-a', 'asia-east1-b', 'asia-east1-c'],
	'asia-east2': ['asia-east2-a', 'asia-east2-b', 'asia-east2-c'],
	'asia-northeast1': ['asia-northeast1-a', 'asia-northeast1-b', 'asia-northeast1-c'],
	'asia-northeast2': ['asia-northeast2-a', 'asia-northeast2-b', 'asia-northeast2-c'],
	'asia-northeast3': ['asia-northeast3-a', 'asia-northeast3-b', 'asia-northeast3-c'],
	'asia-south1': ['asia-south1-a', 'asia-south1-b', 'asia-south1-c'],
	'asia-south2': ['asia-south2-a', 'asia-south2-b', 'asia-south2-c'],
	'asia-southeast1': ['asia-southeast1-a', 'asia-southeast1-b', 'asia-southeast1-c'],
	'asia-southeast2': ['asia-southeast2-a', 'asia-southeast2-b', 'asia-southeast2-c'],
	'australia-southeast1': ['australia-southeast1-a', 'australia-southeast1-b', 'australia-southeast1-c'],
	'australia-southeast2': ['australia-southeast2-a', 'australia-southeast2-b', 'australia-southeast2-c'],
	'europe-central2': ['europe-central2-a', 'europe-central2-b', 'europe-central2-c'],
	'europe-north1': ['europe-north1-a', 'europe-north1-b', 'europe-north1-c'],
	'europe-southwest1': ['europe-southwest1-a', 'europe-southwest1-b', 'europe-southwest1-c'],
	'europe-west1': ['europe-west1-b', 'europe-west1-c', 'europe-west1-d'],
	'europe-west2': ['europe-west2-a', 'europe-west2-b', 'europe-west2-c'],
	'europe-west3': ['europe-west3-a', 'europe-west3-b', 'europe-west3-c'],
	'europe-west4': ['europe-west4-a', 'europe-west4-b', 'europe-west4-c'],
	'europe-west6': ['europe-west6-a', 'europe-west6-b', 'europe-west6-c'],
	'europe-west8': ['europe-west8-a', 'europe-west8-b', 'europe-west8-c'],
	'europe-west9': ['europe-west9-a', 'europe-west9-b', 'europe-west9-c'],
	'me-west1': ['me-west1-a', 'me-west1-b', 'me-west1-c'],
	'northamerica-northeast1': ['northamerica-northeast1-a', 'northamerica-northeast1-b', 'northamerica-northeast1-c'],
	'northamerica-northeast2': ['northamerica-northeast2-a', 'northamerica-northeast2-b', 'northamerica-northeast2-c'],
	'southamerica-east1': ['southamerica-east1-a', 'southamerica-east1-b', 'southamerica-east1-c'],
	'southamerica-west1': ['southamerica-west1-a', 'southamerica-west1-b', 'southamerica-west1-c'],
	'us-central1': ['us-central1-a', 'us-central1-b', 'us-central1-c', 'us-central1-f'],
	'us-east1': ['us-east1-b', 'us-east1-c', 'us-east1-d'],
	'us-east4': ['us-east4-a', 'us-east4-b', 'us-east4-c'],
	'us-east5': ['us-east5-a', 'us-east5-b', 'us-east5-c'],
	'us-south1': ['us-south1-a', 'us-south1-b', 'us-south1-c'],
	'us-west1': ['us-west1-a', 'us-west1-b', 'us-west1-c'],
	'us-west2': ['us-west2-a', 'us-west2-b', 'us-west2-c', 'us-west3-a'],
	'us-west3': ['us-west3-b', 'us-west3-c'],
	'us-west4': ['us-west4-a', 'us-west4-b', 'us-west4-c']
} as const;
export type GCPZone = typeof gcpZones[GCPRegion][number];

export const gcpSpannerRegions = [
	'northamerica-northeast1',
	'northamerica-northeast2',
	'southamerica-east1',
	'southamerica-west1',
	'us-central1',
	'us-east1',
	'us-east4',
	'us-east5',
	'us-south1',
	'us-west1',
	'us-west2',
	'us-west3',
	'us-west4',
	'europe-central2',
	'europe-north1',
	'europe-southwest1',
	'europe-west1',
	'europe-west2',
	'europe-west3',
	'europe-west4',
	'europe-west6',
	'europe-west8',
	'europe-west9',
	'europe-west12',
	'asia-east1',
	'asia-east2',
	'asia-northeast1',
	'asia-northeast2',
	'asia-northeast3',
	'asia-south1',
	'asia-south2',
	'asia-southeast1',
	'asia-southeast2',
	'australia-southeast1',
	'australia-southeast2',
	'me-central1',
	'me-west1'
] as const;

export type GCPSpannerRegion = typeof gcpSpannerRegions[number];

/**
 * Spanner Multi-Region Configurations
 * https://cloud.google.com/spanner/docs/instance-configurations#available-configurations-multi-region
 */
export const spannerMultiRegionConfiguration = {
	asia1: [
		{ type: 'rw', optional: false, region: 'asia-northeast1' },
		{ type: 'rw', optional: false, region: 'asia-northeast2' },
		{ type: 'wi', optional: false, region: 'asia-northeast3' }
	],
	eur3: [
		{ type: 'rw', optional: false, region: 'europe-west1' },
		{ type: 'rw', optional: false, region: 'europe-west2' },
		{ type: 'wi', optional: false, region: 'europe-north1' }
	],
	eur5: [
		{ type: 'rw', optional: false, region: 'europe-west2' },
		{ type: 'rw', optional: false, region: 'europe-west1' },
		{ type: 'wi', optional: false, region: 'europe-west4' }
	],
	eur6: [
		{ type: 'rw', optional: false, region: 'europe-west4' },
		{ type: 'rw', optional: false, region: 'europe-west3' },
		{ type: 'wi', optional: false, region: 'europe-west6' },
		{ type: 'r', optional: true, region: 'us-east1' }
	],
	nam3: [
		{ type: 'rw', optional: false, region: 'us-east4' },
		{ type: 'rw', optional: false, region: 'us-east1' },
		{ type: 'wi', optional: false, region: 'us-central1' },
		{ type: 'r', optional: true, region: 'us-west2' }
	],
	nam6: [
		{ type: 'rw', optional: false, region: 'us-central1' },
		{ type: 'rw', optional: false, region: 'us-east1' },
		{ type: 'r', optional: false, region: 'us-west1' },
		{ type: 'r', optional: false, region: 'us-west2' },
		{ type: 'wi', optional: false, region: 'us-central2' }
	],
	nam7: [
		{ type: 'rw', optional: false, region: 'us-central1' },
		{ type: 'rw', optional: false, region: 'us-east4' },
		{ type: 'wi', optional: false, region: 'us-central2' },
		{ type: 'r', optional: true, region: 'us-east1' },
		{ type: 'r', optional: true, region: 'us-south1' },
		{ type: 'r', optional: true, region: 'europe-west1' }
	],
	nam8: [
		{ type: 'rw', optional: false, region: 'us-west2' },
		{ type: 'rw', optional: false, region: 'us-west1' },
		{ type: 'wi', optional: false, region: 'us-west3' }
	],
	nam9: [
		{ type: 'rw', optional: false, region: 'us-east4' },
		{ type: 'rw', optional: false, region: 'us-central1' },
		{ type: 'wi', optional: false, region: 'us-east1' },
		{ type: 'r', optional: false, region: 'us-west1' }
	],
	nam10: [
		{ type: 'rw', optional: false, region: 'us-central1' },
		{ type: 'rw', optional: false, region: 'us-west3' },
		{ type: 'wi', optional: false, region: 'us-central2' }
	],
	nam11: [
		{ type: 'rw', optional: false, region: 'us-central1' },
		{ type: 'rw', optional: false, region: 'us-east1' },
		{ type: 'wi', optional: false, region: 'us-central1' },
		{ type: 'r', optional: true, region: 'us-west1' }
	],
	nam12: [
		{ type: 'rw', optional: false, region: 'us-central1' },
		{ type: 'rw', optional: false, region: 'us-east4' },
		{ type: 'r', optional: false, region: 'us-west1' },
		{ type: 'wi', optional: false, region: 'us-central2' }
	],
	nam13: [
		{ type: 'rw', optional: false, region: 'us-central1' },
		{ type: 'rw', optional: false, region: 'us-central2' },
		{ type: 'wi', optional: false, region: 'us-west3' }
	],
	'nam-eur-asia1': [
		{ type: 'rw', optional: false, region: 'us-central1' },
		{ type: 'rw', optional: false, region: 'us-central2' },
		{ type: 'r', optional: false, region: 'europe-west1' },
		{ type: 'r', optional: false, region: 'asia-east1' },
		{ type: 'wi', optional: false, region: 'us-east1' }
	],
	'nam-eur-asia3': [
		{ type: 'rw', optional: false, region: 'us-central1' },
		{ type: 'rw', optional: false, region: 'us-east1' },
		{ type: 'r', optional: false, region: 'europe-west1' },
		{ type: 'r', optional: false, region: 'europe-west4' },
		{ type: 'r', optional: false, region: 'asia-east1' },
		{ type: 'wi', optional: false, region: 'us-central2' }
	]
} as const;


type SpannerMultiRegionType = typeof spannerMultiRegionConfiguration;
export type SpannerMultiRegionName = keyof SpannerMultiRegionType;

export type SpannerMultiRegionRegion = SpannerMultiRegionType[SpannerMultiRegionName][number]['region'];
export type SpannerConfigRegionType = SpannerMultiRegionType[SpannerMultiRegionName][number]['type'];

export type SpannerRegionByNameType<N extends SpannerMultiRegionName, T extends SpannerConfigRegionType, O extends boolean = any> = (SpannerMultiRegionType[N][number] & { type: T, optional: O })['region'];
export type SpannerReadWriteRegionsByName<N extends SpannerMultiRegionName> = SpannerRegionByNameType<N, 'rw', false>;

export default { GCP_COMPONENT_PREFIX };
