import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';
import { describe, expect, it } from 'vitest';

import type * as apps from '../../src/packages/gcp/apps';
import type * as frontend from '../../src/packages/gcp/https-frontend';
import type * as lb from '../../src/packages/gcp/lb';
import { resolveOutput } from '../helpers/outputs';
import { expectDefined, expectRecord } from '../helpers/narrow';
import { requireSource } from './harness/load-sources';
import { captureTree, describeTree, ofType, useIsolatedHome } from './harness/pulumi-tree';
import type { TreeSnapshot } from './harness/pulumi-tree';

const { StaticWebApp } = requireSource<typeof apps>('src/packages/gcp/apps.ts');
const { buildRouteRules, parseFrontEndConfig } = requireSource<typeof frontend>('src/packages/gcp/https-frontend.ts');
const { ExternalLoadBalancer } = requireSource<typeof lb>('src/packages/gcp/lb.ts');

const STATIC_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/static');
const SSL_POLICY = 'gcp:compute/sSLPolicy:SSLPolicy';
const HTTPS_PROXY = 'gcp:compute/targetHttpsProxy:TargetHttpsProxy';
const CERTIFICATE_MAP_ENTRY = 'gcp:certificatemanager/certificateMapEntry:CertificateMapEntry';
const DOMAIN = 'app.example.com';
const STATIC_PATHS = [ '/assets/', '/icons/', '/fonts/', '/images/' ];

/** The rules that the two front ends of 1.0.95 build, written out: the prefix rules, then the exact files, then the rest */
function prefixRules(paths: string[], service: string) {
	return(paths.map(function(prefixMatch, index) {
		return({ priority: index + 1, matchRules: [{ prefixMatch }], service });
	}));
}

function fileRules(files: string[], first: number, service: string) {
	return(files.map(function(fullPathMatch, index) {
		return({ priority: first + index, matchRules: [{ fullPathMatch }], service });
	}));
}

function catchAll(priority: number, service: string) {
	return({ priority, matchRules: [{ pathTemplateMatch: '/**' }], service, routeAction: { urlRewrite: { pathTemplateRewrite: '/' }}});
}

/*
 * One route builder serves StaticWebApp and FullStackApp. These are the
 * lists the two of them built inline in 1.0.95: a
 * different list updates the URL map of an app that is already deployed.
 */
describe('buildRouteRules', function() {
	const CUSTOM_PATHS = [ '/static/' ];
	const CUSTOM_FILES = [ '/robots.txt', '/app.css' ];

	const cases = [
		{
			title: 'the StaticWebApp defaults: four prefixes, no exact file, and the catch-all',
			spec: { staticPaths: STATIC_PATHS, staticFiles: [], frontendService: 'bucket-id' },
			rules: [ ...prefixRules(STATIC_PATHS, 'bucket-id'), catchAll(5, 'bucket-id') ]
		},
		{
			title: 'the FullStackApp defaults: four prefixes, the favicon, the API prefix and the catch-all',
			spec: { staticPaths: STATIC_PATHS, staticFiles: [ '/favicon.svg' ], api: { prefix: '/api', service: 'api-id' }, frontendService: 'bucket-id' },
			rules: [
				...prefixRules(STATIC_PATHS, 'bucket-id'),
				...fileRules([ '/favicon.svg' ], 5, 'bucket-id'),
				{ priority: 6, matchRules: [{ prefixMatch: '/api' }], service: 'api-id' },
				catchAll(7, 'bucket-id')
			]
		},
		{
			title: 'custom paths and files: priorities follow the paths, then the files',
			spec: { staticPaths: CUSTOM_PATHS, staticFiles: CUSTOM_FILES, frontendService: 'bucket-id' },
			rules: [ ...prefixRules(CUSTOM_PATHS, 'bucket-id'), ...fileRules(CUSTOM_FILES, 2, 'bucket-id'), catchAll(4, 'bucket-id') ]
		},
		{
			title: 'a custom API prefix with no static path or file',
			spec: { staticPaths: [], staticFiles: [], api: { prefix: '/v2', service: 'api-id' }, frontendService: 'bucket-id' },
			rules: [ { priority: 1, matchRules: [{ prefixMatch: '/v2' }], service: 'api-id' }, catchAll(2, 'bucket-id') ]
		}
	];

	it.each(cases)('builds $title', function({ spec, rules }) {
		expect(buildRouteRules(spec)).toEqual(rules);
	});
});

/** What parseFrontEndConfig returns for a configuration the caller wrote inside a program */
async function parseInProgram(makeConfig: () => apps.LoadBalancerConfig) {
	const parsed: ReturnType<typeof parseFrontEndConfig>[] = [];
	await captureTree(function() {
		parsed.push(parseFrontEndConfig(makeConfig()));
	});

	return(expectDefined(parsed[0], 'the parsed configuration'));
}

/** The value with every Output inside it resolved */
function settled(value: unknown) {
	return(resolveOutput(pulumi.output(value)));
}

describe('parseFrontEndConfig', function() {
	useIsolatedHome();

	const DOMAINS = [ DOMAIN ];

	/* [ the certificate the caller configures, the choice that comes out ] */
	const certificates = [
		{
			title: 'a Compute certificate of the caller to the compute choice',
			ssl: function() {
				return({ sslCertificate: new gcp.compute.ManagedSslCertificate('caller-compute-cert', { managed: { domains: DOMAINS }}) });
			},
			choice: { kind: 'compute', id: 'caller-compute-cert-id' }
		},
		{
			title: 'a Certificate Manager certificate of the caller to the certificate-manager choice',
			ssl: function() {
				return({ sslCertificate: new gcp.certificatemanager.Certificate('caller-manager-cert', { managed: { domains: DOMAINS }}) });
			},
			choice: { kind: 'certificate-manager', id: 'caller-manager-cert-id' }
		},
		{
			title: 'domains alone to a managed certificate, with no version and no protection',
			ssl: function() {
				return({ domains: DOMAINS });
			},
			choice: { kind: 'managed', domains: DOMAINS }
		},
		{
			title: 'domains with a version and protectCert to a managed certificate that carries both',
			ssl: function() {
				return({ domains: DOMAINS, sslCertificateVersion: 3, protectCert: true });
			},
			choice: { kind: 'managed', domains: DOMAINS, version: 3, protect: true }
		}
	];

	it.each(certificates)('maps $title', async function(testCase) {
		const parsed = await parseInProgram(function() {
			return({ domain: DOMAIN, ssl: testCase.ssl() });
		});

		expect(await settled(parsed.cert)).toMatchObject(testCase.choice);
	});

	it('leaves version and protect unset for domains alone', async function() {
		const parsed = await parseInProgram(function() {
			return({ domain: DOMAIN, ssl: { domains: DOMAINS }});
		});
		const cert = expectRecord(await settled(parsed.cert), 'the certificate choice');

		expect(cert.version).toBeUndefined();
		expect(cert.protect).toBeUndefined();
	});

	/* [ what the caller passes for sslPolicy, the choice that comes out ] */
	const policies = [
		{
			title: 'no sslPolicy to a policy to create, with the default TLS settings',
			policy: function() {
				return({});
			},
			choice: { kind: 'create', profile: 'MODERN', minTlsVersion: 'TLS_1_2' }
		},
		{
			title: 'false to no policy',
			policy: function() {
				return({ sslPolicy: false as const });
			},
			choice: { kind: 'none' }
		},
		{
			title: 'a policy of the caller to the existing choice',
			policy: function() {
				return({ sslPolicy: new gcp.compute.SSLPolicy('caller-policy', { profile: 'RESTRICTED' }) });
			},
			choice: { kind: 'existing', id: 'caller-policy-id' }
		}
	];

	it.each(policies)('maps $title', async function(testCase) {
		const parsed = await parseInProgram(function() {
			return({ domain: DOMAIN, ssl: { domains: DOMAINS }, ...testCase.policy() });
		});
		const settledPolicy = await settled(parsed.sslPolicy);

		expect(settledPolicy).toMatchObject(testCase.choice);
		expect(Object.keys(expectRecord(settledPolicy, 'the policy choice'))).toHaveLength(Object.keys(testCase.choice).length);
	});
});

function withoutPolicy(tree: TreeSnapshot) {
	const resources = tree.resources.filter(function(resource) {
		return(resource.type !== SSL_POLICY);
	}).map(function(resource) {
		if (resource.type !== HTTPS_PROXY) {
			return(resource);
		}

		const inputs = Object.entries(expectRecord(resource.inputs, `the inputs of ${resource.name}`)).filter(function([ key ]) {
			return(key !== 'sslPolicy');
		});

		return({ ...resource, inputs: Object.fromEntries(inputs) });
	});

	return(describeTree({ ...tree, resources }));
}

/*
 * LoadBalancerConfig.sslPolicy: left out, the app gets
 * its own policy; given, it uses the caller's; false, it has none, as in
 * 1.0.95. Whichever it is, nothing else about the app differs.
 */
describe('LoadBalancerConfig.sslPolicy', function() {
	useIsolatedHome();

	function appTree(makeExtras: () => Partial<apps.LoadBalancerConfig>) {
		return(captureTree(function() {
			return(new StaticWebApp('policy-app', {
				staticFilesPath: STATIC_DIRECTORY,
				loadBalancer: { domain: DOMAIN, ssl: { domains: [ DOMAIN ] }, ...makeExtras() }
			}));
		}));
	}

	function proxyOf(tree: TreeSnapshot) {
		return(expectDefined(ofType(tree, HTTPS_PROXY)[0], 'the HTTPS proxy'));
	}

	it('creates policy-app-ssl-policy and attaches it when the caller passes none', async function() {
		const tree = await appTree(function() {
			return({});
		});
		const [ policy ] = ofType(tree, SSL_POLICY);

		expect(policy?.name).toBe('policy-app-ssl-policy');
		expect(proxyOf(tree).dependsOn).toContain(policy?.urn);
	});

	it('attaches the policy of the caller, and creates none, when the caller passes one', async function() {
		const tree = await appTree(function() {
			return({ sslPolicy: new gcp.compute.SSLPolicy('caller-policy', { profile: 'RESTRICTED' }) });
		});
		const [ policy ] = ofType(tree, SSL_POLICY);

		expect(ofType(tree, SSL_POLICY).map(function(resource) {
			return(resource.name);
		})).toEqual([ 'caller-policy' ]);
		expect(proxyOf(tree).dependsOn).toContain(policy?.urn);
		expect(expectRecord(proxyOf(tree).inputs, 'the inputs of the proxy').sslPolicy).toBeTypeOf('string');
	});

	it('creates no policy and attaches none when the caller passes false', async function() {
		const tree = await appTree(function() {
			return({ sslPolicy: false });
		});

		expect(ofType(tree, SSL_POLICY)).toEqual([]);
		expect(expectRecord(proxyOf(tree).inputs, 'the inputs of the proxy')).not.toHaveProperty('sslPolicy');
	});

	it('changes nothing else about the app: with its policy and proxy attachment taken out, it is the app that has false', async function() {
		const withPolicy = await appTree(function() {
			return({});
		});
		const without = await appTree(function() {
			return({ sslPolicy: false });
		});

		expect(withoutPolicy(withPolicy)).toEqual(describeTree(without));
	});
});

/*
 * An ExternalLoadBalancer takes the same certificate and SSL policy choices
 * as an app: a Certificate Manager certificate with `domainName` gives its
 * map entry that hostname, and `sslPolicy` is created, the caller's, or none.
 */
describe('the certificate and SSL policy of an ExternalLoadBalancer', function() {
	useIsolatedHome();

	type BalancerArgs = Partial<ConstructorParameters<typeof lb.ExternalLoadBalancer>[1]>;

	function balancerTree(name: string, makeExtras: () => BalancerArgs) {
		return(captureTree(function() {
			const certificate = new gcp.certificatemanager.Certificate(`${name}-caller-cert`, { managed: { domains: [ DOMAIN ] }});

			return(new ExternalLoadBalancer(name, {
				common: { gcp: { project: 'project-id' }},
				baseDescription: 'test app',
				healthCheck: new gcp.compute.HealthCheck(`${name}-health`, { httpHealthCheck: { port: 8080 }}),
				target: { type: 'NEG', host: 'backend.example.com' },
				sslCertificate: certificate,
				...makeExtras()
			}));
		}));
	}

	function proxyInputs(tree: TreeSnapshot) {
		return(expectRecord(expectDefined(ofType(tree, HTTPS_PROXY)[0], 'the HTTPS proxy').inputs, 'the inputs of the proxy'));
	}

	it('gives the map entry of a Certificate Manager certificate the domain name as its hostname', async function() {
		const tree = await balancerTree('elb-hostname', function() {
			return({ domainName: DOMAIN });
		});
		const entry = expectDefined(ofType(tree, CERTIFICATE_MAP_ENTRY)[0], 'the certificate map entry');

		expect(expectRecord(entry.inputs, 'the inputs of the entry')).toMatchObject({ hostname: DOMAIN });
	});

	it('matches every host without a domain name', async function() {
		const tree = await balancerTree('elb-all-hosts', function() {
			return({});
		});
		const entry = expectDefined(ofType(tree, CERTIFICATE_MAP_ENTRY)[0], 'the certificate map entry');

		expect(expectRecord(entry.inputs, 'the inputs of the entry')).not.toHaveProperty('hostname');
	});

	it('attaches the policy of the caller, and creates none', async function() {
		const tree = await balancerTree('elb-caller-policy', function() {
			return({ sslPolicy: new gcp.compute.SSLPolicy('elb-caller-policy-policy', { profile: 'RESTRICTED' }) });
		});

		expect(ofType(tree, SSL_POLICY).map(function(resource) {
			return(resource.name);
		})).toEqual([ 'elb-caller-policy-policy' ]);
		expect(proxyInputs(tree).sslPolicy).toBeTypeOf('string');
	});

	it('creates no policy and attaches none when the caller passes false', async function() {
		const tree = await balancerTree('elb-no-policy', function() {
			return({ sslPolicy: false });
		});

		expect(ofType(tree, SSL_POLICY)).toEqual([]);
		expect(proxyInputs(tree)).not.toHaveProperty('sslPolicy');
	});
});
