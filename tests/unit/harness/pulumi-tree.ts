import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll } from 'vitest';
import * as pulumi from '@pulumi/pulumi';
import type * as resourceProto from '@pulumi/pulumi/proto/resource_pb';

import { expectArray, expectString, optionalRecord } from '../../helpers/narrow';
import { resolveOutput } from '../../helpers/outputs';
import type { UnknownRecord } from '../../helpers/narrow';

/*
 * Records the resource tree that a Pulumi program registers, in Pulumi's own
 * test mode (`pulumi.runtime.setMocks`), without any network access.
 *
 * Mocks alone only show `{type, name, inputs}`, so this harness also wraps
 * the mock resource monitor's `registerResource`. That is the one place in
 * the tests that touches runtime internals, and everything that depends on
 * the shape of a registration request lives in this file.
 */

/** The protobuf classes the SDK builds its requests from (found by name, so the SDK's own copy is used) */
const nodeRequire: <Exports>(id: string) => Exports = createRequire(import.meta.url);
const resourceMessages = nodeRequire<typeof resourceProto>('@pulumi/pulumi/proto/resource_pb');
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export interface TreeResource {
	/** The URN the Pulumi engine would assign, with every ancestor type in it */
	urn: string;
	type: string;
	name: string;
	custom: boolean;
	parent?: string;
	/** URN of the explicit provider (without the provider id) */
	provider?: string;
	/** The resource's own aliases as URNs (inherited aliases are not in here) */
	aliases: string[];
	deletedWith?: string;
	/** URNs the resource waits for: its `dependsOn` and the resources its inputs come from (not part of a snapshot) */
	dependsOn?: string[];
	protect?: boolean;
	retainOnDelete?: boolean;
	/** Normalized inputs of a custom resource (components only echo their arguments, so none are kept) */
	inputs?: unknown;
}

export interface TreeSnapshot {
	project: string;
	stack: string;
	/** Sorted by URN */
	resources: TreeResource[];
}

export interface CaptureOptions {
	project?: string;
	stack?: string;
	/** How long to wait for the program to finish registering (default 60 seconds) */
	settleTimeoutMs?: number;
}

type OutputsOf = (name: string, inputs: UnknownRecord) => UnknownRecord;

/*
 * Outputs that the components read from a resource after it is created
 * (a real provider would compute them). Everything else only needs the
 * generic outputs from `defaultOutputs`.
 */
const KNOWN_OUTPUTS: { [type: string]: OutputsOf } = {
	'gcp:serviceaccount/account:Account': function(name, inputs) {
		const accountId = typeof inputs.accountId === 'string' ? inputs.accountId : name;

		return({ email: `${accountId}@mock.iam.gserviceaccount.com` });
	},
	'gcp:sql/databaseInstance:DatabaseInstance': function(name) {
		return({
			firstIpAddress: `ip.${name}`,
			connectionName: `connection.${name}`,
			serverCaCerts: [ { cert: `ca-certificate.${name}` } ]
		});
	},
	/* A key made now, so that no key is kept in the repository */
	'tls:index/privateKey:PrivateKey': function() {
		const pair = generateKeyPairSync('ec', {
			namedCurve: 'prime256v1',
			privateKeyEncoding: { type: 'sec1', format: 'pem' },
			publicKeyEncoding: { type: 'spki', format: 'pem' }
		});

		return({ privateKeyPem: pair.privateKey, publicKeyPem: pair.publicKey });
	},
	'random:index/randomString:RandomString': function(name) {
		return({ result: `random.${name}` });
	},
	'gcp:redis/instance:Instance': function(name) {
		return({ host: `redis.${name}`, port: 6379, authString: `auth.${name}` });
	},
	'gcp:compute/globalAddress:GlobalAddress': function(name) {
		return({ address: `address.${name}` });
	},
	'gcp:compute/address:Address': function(name) {
		return({ address: `address.${name}` });
	},
	'gcp:secretmanager/secretVersion:SecretVersion': function() {
		return({ version: '1' });
	},
	'gcp:cloudrun/service:Service': function(name) {
		return({ statuses: [ { url: `https://${name}.run.app` } ] });
	},
	'pulumi-nodejs:dynamic:Resource': function(name, inputs) {
		const images = optionalRecord(inputs.build)?.images;
		let imageName = `image.${name}`;
		if (Array.isArray(images)) {
			imageName = String(images[0]);
		}

		/* The union of the outputs of the three dynamic resources in the library */
		return({
			digest: `sha256:${name}`,
			status: 'SUCCESS',
			results: { images: [ { name: imageName, digest: `sha256:${name}` } ] },
			logUrl: `https://logs.example/${name}`,
			statusDetail: 'done',
			executionName: `execution.${name}`,
			createTime: '2026-01-01T00:00:00Z',
			completionTime: '2026-01-01T00:01:00Z',
			logUri: `https://logs.example/${name}`
		});
	}
};

/** Invokes the cases are allowed to make. Any other invoke fails the test. */
const MOCKED_CALLS: { [token: string]: (inputs: UnknownRecord) => UnknownRecord } = {
	'gcp:compute/getImage:getImage': function() {
		return({ id: 'projects/cos-cloud/global/images/cos-stable-mock' });
	}
};

function defaultOutputs(name: string, inputs: UnknownRecord): UnknownRecord {
	return({
		name: inputs.name ?? name,
		selfLink: `self-link.${name}`
	});
}

const mocks: pulumi.runtime.Mocks = {
	newResource: function(args) {
		const inputs = optionalRecord(args.inputs) ?? {};
		if (!args.custom) {
			return({ id: undefined, state: inputs });
		}

		const known = KNOWN_OUTPUTS[args.type]?.(args.name, inputs);

		return({
			id: `${args.name}-id`,
			state: { ...defaultOutputs(args.name, inputs), ...inputs, ...known }
		});
	},
	call: function(args) {
		const call = MOCKED_CALLS[args.token];
		if (call === undefined) {
			throw(new Error(`Unexpected invoke of ${args.token}: add it to MOCKED_CALLS only if the test must make it`));
		}

		return(call(optionalRecord(args.inputs) ?? {}));
	}
};

/** Calls a method of an object whose type the SDK does not publish */
function callMethod(target: object, method: unknown, args: unknown[]): void {
	if (typeof method !== 'function') {
		throw(new TypeError('The mock resource monitor does not have the method this harness wraps; the SDK changed'));
	}

	Reflect.apply(method, target, args);
}

/*
 * Rewrites the text that depends on the machine, so a snapshot made on one
 * machine matches on every other one
 */
function normalizeText(text: string, roots: [string, string][]): string {
	let normalized = text;
	for (const [root, replacement] of roots) {
		normalized = normalized.split(root).join(replacement);
	}

	return(normalized
		.replace(/docker-build-[A-Za-z0-9]+/g, 'docker-build-<random>')
		.replace(/pulumi-tarballs\/[0-9a-f]{32}-/g, 'pulumi-tarballs/<directory-hash>-'));
}

function machineRoots(): [string, string][] {
	/* The repository comes first because a checkout can live under the temporary directory */
	const roots: [string, string][] = [ [ repositoryRoot, '<repo>' ] ];
	const home = process.env.HOME;
	if (home !== undefined && home !== '') {
		roots.push([ home, '<home>' ]);
	}

	roots.push([ os.tmpdir(), '<tmp>' ], [ '/tmp', '<tmp>' ]);

	return(roots);
}

/** Cuts a value that came over the wire down to what is worth keeping in a snapshot */
/** Plain comparison of code units: the same order on every machine, unlike a locale's */
function compareStrings(a: string, b: string) {
	if (a < b) {
		return(-1);
	}

	if (a > b) {
		return(1);
	}

	return(0);
}

function compareUrns(a: TreeResource, b: TreeResource) {
	return(compareStrings(a.urn, b.urn));
}

function normalizeValue(value: unknown, roots: [string, string][]): unknown {
	if (typeof value === 'string') {
		if (value === pulumi.runtime.unknownValue) {
			return('<unknown>');
		}

		return(normalizeText(value, roots));
	}

	if (Array.isArray(value)) {
		return(value.map(function(item: unknown) {
			return(normalizeValue(item, roots));
		}));
	}

	const record = optionalRecord(value);
	if (record === undefined) {
		return(value);
	}

	switch (record[pulumi.runtime.specialSigKey]) {
		case pulumi.runtime.specialSecretSig:
			return('<secret>');
		case pulumi.runtime.specialAssetSig:
			return({ asset: normalizeValue(record.path ?? record.text ?? record.uri, roots) });
		case pulumi.runtime.specialArchiveSig:
			return({ archive: normalizeValue(record.path ?? record.assets ?? record.uri, roots) });
		case pulumi.runtime.specialResourceSig:
			return({ resource: normalizeValue(record.urn, roots) });
		default:
			break;
	}

	const normalized: UnknownRecord = {};
	for (const key of Object.keys(record).sort(compareStrings)) {
		normalized[key] = normalizeValue(record[key], roots);
	}

	return(normalized);
}

interface CaptureState {
	project: string;
	stack: string;
	resources: TreeResource[];
	/** Engine-form URN to the URN the mock monitor knows the resource by */
	mockUrns: Map<string, string>;
	/**
	 * Problems found while recording. They are thrown once the program is done:
	 * an error returned to the SDK would only surface as an unhandled rejection.
	 */
	failures: Error[];
}

/** Turns the alias list of a request into URNs, the way the engine reads it */
function aliasUrns(request: resourceProto.RegisterResourceRequest, state: CaptureState) {
	return(Promise.all(request.getAliasesList().map(async function(alias) {
		const spec = alias.getSpec();
		if (spec === undefined) {
			return(alias.getUrn());
		}

		let parentUrn: string | undefined;
		if (spec.hasParenturn()) {
			parentUrn = spec.getParenturn();
		}

		const urn = pulumi.createUrn(
			spec.getName() || request.getName(),
			spec.getType() || request.getType(),
			parentUrn,
			spec.getProject() || state.project,
			spec.getStack() || state.stack
		);

		return(await resolveOutput(urn));
	})));
}

async function recordRegistration(request: resourceProto.RegisterResourceRequest, response: resourceProto.RegisterResourceResponse, state: CaptureState) {
	const roots = machineRoots();
	const parent = request.getParent() || undefined;
	const urn = await resolveOutput(pulumi.createUrn(request.getName(), request.getType(), parent, state.project, state.stack));
	if (state.mockUrns.has(urn)) {
		state.failures.push(new Error(`Pulumi would reject this program: ${urn} is registered twice`));
	}

	state.mockUrns.set(urn, response.getUrn());
	response.setUrn(urn);

	const resource: TreeResource = {
		urn,
		type: request.getType(),
		name: request.getName(),
		custom: request.getCustom(),
		aliases: await aliasUrns(request, state)
	};

	if (parent !== undefined) {
		resource.parent = parent;
	}

	/* The provider reference is "<provider URN>::<provider id>" */
	const providerReference = request.getProvider();
	if (providerReference !== '') {
		resource.provider = providerReference.slice(0, providerReference.lastIndexOf('::'));
	}

	if (request.getDeletedwith() !== '') {
		resource.deletedWith = request.getDeletedwith();
	}

	const dependencies = request.getDependenciesList();
	if (dependencies.length > 0) {
		resource.dependsOn = [ ...dependencies ].sort(compareStrings);
	}

	if (request.hasProtect()) {
		resource.protect = request.getProtect();
	}

	if (request.hasRetainondelete()) {
		resource.retainOnDelete = request.getRetainondelete();
	}

	const object = request.getObject()?.toJavaScript();
	if (request.getCustom() && object !== undefined) {
		/* The source of a dynamic provider is a serialized closure, which changes with every compiler setting */
		const inputs: UnknownRecord = {};
		for (const [ key, value ] of Object.entries(object)) {
			if (key !== '__provider') {
				inputs[key] = value;
			}
		}

		resource.inputs = normalizeValue(inputs, roots);
	}

	state.resources.push(resource);
}

/** Wraps the mock monitor so registrations are recorded and carry the URN the engine would give them */
function instrumentMonitor(state: CaptureState) {
	const monitor = pulumi.runtime.getMonitor();
	if (monitor === undefined) {
		throw(new Error('No resource monitor: pulumi.runtime.setMocks must run first'));
	}

	const register: unknown = Reflect.get(monitor, 'registerResource');
	const registerOutputs: unknown = Reflect.get(monitor, 'registerResourceOutputs');
	const invoke: unknown = Reflect.get(monitor, 'invoke');

	Reflect.set(monitor, 'registerResource', function(request: unknown, callback: unknown) {
		if (!(request instanceof resourceMessages.RegisterResourceRequest) || typeof callback !== 'function') {
			throw(new TypeError('Unsupported registerResource call: the SDK changed the monitor interface'));
		}

		callMethod(monitor, register, [ request, function(error: unknown, response: unknown) {
			if (error || !(response instanceof resourceMessages.RegisterResourceResponse)) {
				Reflect.apply(callback, undefined, [ error, response ]);
				return;
			}

			recordRegistration(request, response, state).then(function() {
				Reflect.apply(callback, undefined, [ null, response ]);
			}, function(recordError: unknown) {
				state.failures.push(new Error('The harness could not record a registration', { cause: recordError }));
				Reflect.apply(callback, undefined, [ null, response ]);
			});
		} ]);
	});

	/*
	 * The mock monitor knows resources by its own (shorter) URN, so the
	 * requests that name a resource are translated back to it
	 */
	Reflect.set(monitor, 'invoke', function(request: unknown, callback: unknown) {
		if (!(request instanceof resourceMessages.ResourceInvokeRequest)) {
			throw(new TypeError('Unsupported invoke call: the SDK changed the monitor interface'));
		}

		/* Reading a resource reference asks the monitor for the resource's state by URN */
		if (request.getTok() === 'pulumi:pulumi:getResource') {
			const urnArgument = request.getArgs()?.getFieldsMap().get('urn');
			const mockUrn = state.mockUrns.get(urnArgument?.getStringValue() ?? '');
			if (mockUrn !== undefined) {
				urnArgument?.setStringValue(mockUrn);
			}
		}

		callMethod(monitor, invoke, [ request, callback ]);
	});

	Reflect.set(monitor, 'registerResourceOutputs', function(request: unknown, callback: unknown) {
		if (!(request instanceof resourceMessages.RegisterResourceOutputsRequest)) {
			throw(new TypeError('Unsupported registerResourceOutputs call: the SDK changed the monitor interface'));
		}

		const mockUrn = state.mockUrns.get(request.getUrn());
		if (mockUrn !== undefined) {
			request.setUrn(mockUrn);
		}

		callMethod(monitor, registerOutputs, [ request, callback ]);
	});
}

/** Waits until the program has no more RPCs in flight and no new registration shows up */
async function settle(state: CaptureState, timeoutMs: number) {
	const waitForRPCs: unknown = Reflect.get(pulumi.runtime, 'waitForRPCs');
	if (typeof waitForRPCs !== 'function') {
		throw(new TypeError('pulumi.runtime.waitForRPCs is gone; the harness must find another way to know the program is done'));
	}

	/* Each round depends on the registrations the previous one let through, so the rounds cannot run side by side */
	const quiet = async function(lastCount: number, stableRounds: number): Promise<void> {
		if (stableRounds >= 3) {
			return;
		}

		const drained: unknown = Reflect.apply(waitForRPCs, undefined, []);
		await drained;
		await new Promise<void>(function(resolve) {
			setTimeout(resolve, 0);
		});

		if (state.resources.length === lastCount) {
			return(await quiet(lastCount, stableRounds + 1));
		}

		return(await quiet(state.resources.length, 0));
	};

	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>(function(_ignored_resolve, reject) {
		timer = setTimeout(function() {
			reject(new Error(`The program did not finish registering resources within ${timeoutMs} ms (${state.resources.length} registered); an Output probably never resolves`));
		}, timeoutMs);
	});

	try {
		await Promise.race([ quiet(-1, 0), timeout ]);
	} finally {
		clearTimeout(timer);
	}
}

let capturing = false;

/**
 * Runs `build` in Pulumi test mode and returns every resource it registered,
 * including the ones created later inside `apply` callbacks. Captures cannot
 * overlap because the Pulumi runtime state is process-wide.
 */
export async function captureTree(build: () => unknown, options: CaptureOptions = {}): Promise<TreeSnapshot> {
	if (capturing) {
		throw(new Error('captureTree cannot run twice at the same time'));
	}

	capturing = true;
	try {
		const state: CaptureState = {
			project: options.project ?? 'project',
			stack: options.stack ?? 'stack',
			resources: [],
			mockUrns: new Map(),
			failures: []
		};

		await pulumi.runtime.setMocks(mocks, state.project, state.stack, false);
		instrumentMonitor(state);

		try {
			await build();
		} finally {
			/* A program that throws has already started registrations; they must land in this capture */
			await settle(state, options.settleTimeoutMs ?? 60_000);
		}

		const [ failure ] = state.failures;
		if (failure !== undefined) {
			throw(failure);
		}

		state.resources.sort(compareUrns);

		return({
			project: state.project,
			stack: state.stack,
			resources: state.resources
		});
	} finally {
		capturing = false;
	}
}

/** Points HOME at a fresh directory for the tests of the enclosing `describe` (tarballs are cached under HOME) */
export function useIsolatedHome() {
	let originalHome: string | undefined;
	let isolatedHome: string | undefined;

	beforeAll(function() {
		originalHome = process.env.HOME;
		isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pulumi-tree-home-'));
		process.env.HOME = isolatedHome;
	});

	afterAll(function() {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}

		if (isolatedHome !== undefined) {
			fs.rmSync(isolatedHome, { recursive: true, force: true });
		}
	});
}

export interface LegacyMatch {
	/** Legacy URNs that no resource of the tree answers to */
	unmatched: string[];
	/** Legacy URNs that more than one resource answers to */
	ambiguous: string[];
}

/*
 * The SDK's `allAliases` wants a Resource as the parent. The marker
 * `__pulumiResource` is what `Resource.isInstance` looks for, so the check
 * below is the SDK's own, and the adapter only carries what `allAliases` reads.
 */
function parentAdapter(urn: string, aliases: string[]) {
	const adapter = {
		__pulumiResource: true,
		urn: pulumi.output(urn),
		__aliases: aliases
	};

	if (!pulumi.Resource.isInstance(adapter)) {
		throw(new Error('The SDK no longer recognizes the parent adapter as a Resource'));
	}

	return(adapter);
}

/**
 * Finds, for every URN of a released version, the resource of the tree that
 * keeps it: the resource whose URN it is, or one that lists it as an alias
 * (its own, or one inherited from an ancestor the way the SDK computes it).
 */
export async function matchLegacyUrns(tree: TreeSnapshot, legacyUrns: string[]): Promise<LegacyMatch> {
	const byUrn = new Map<string, TreeResource>();
	for (const resource of tree.resources) {
		byUrn.set(resource.urn, resource);
	}

	/* The complete alias set of each resource, filled parent first */
	const completeAliases = new Map<string, Promise<string[]>>();
	function aliasesOf(resource: TreeResource): Promise<string[]> {
		const known = completeAliases.get(resource.urn);
		if (known !== undefined) {
			return(known);
		}

		const computed = (async function(): Promise<string[]> {
			let complete = resource.aliases;
			if (resource.parent !== undefined) {
				const parent = byUrn.get(resource.parent);
				if (parent === undefined) {
					throw(new Error(`${resource.urn} has a parent that is not in the tree: ${resource.parent}`));
				}

				const adapter = parentAdapter(parent.urn, await aliasesOf(parent));
				const outputs = pulumi.allAliases(resource.aliases, resource.name, resource.type, adapter, parent.name);
				complete = await Promise.all(outputs.map(resolveOutput));
			}

			return(complete);
		})();
		completeAliases.set(resource.urn, computed);

		return(computed);
	}

	const keepers = new Map<string, Set<string>>();
	for (const legacy of legacyUrns) {
		keepers.set(legacy, new Set());
	}

	await Promise.all(tree.resources.map(async function(resource) {
		for (const urn of [ resource.urn, ...await aliasesOf(resource) ]) {
			keepers.get(urn)?.add(resource.urn);
		}
	}));

	const result: LegacyMatch = { unmatched: [], ambiguous: [] };
	for (const [ legacy, resources ] of keepers) {
		if (resources.size === 0) {
			result.unmatched.push(legacy);
		} else if (resources.size > 1) {
			result.ambiguous.push(legacy);
		}
	}

	return(result);
}

/** The resources of a tree that have a type */
export function ofType(tree: TreeSnapshot, type: string) {
	return(tree.resources.filter(function(resource) {
		return(resource.type === type);
	}));
}

/*
 * The aliases that move a resource: those that keep its type. The provider
 * SDK adds aliases of its own that change the type (for example for
 * serviceaccount.Account), which are not moves.
 */
export function moveAliases(resource: TreeResource) {
	return(resource.aliases.filter(function(alias) {
		return(alias.split('::')[2]?.split('$').pop() === resource.type);
	}));
}

/** The URNs of a tree, sorted: what a baseline file holds */
export function urnsOf(tree: TreeSnapshot): string[] {
	return(tree.resources.map(function(resource) {
		return(resource.urn);
	}));
}

/** Reads the URN list of one case from the parsed JSON of a baseline file */
export function readBaselineCase(baseline: unknown, caseName: string): string[] {
	const cases = optionalRecord(optionalRecord(baseline)?.cases);
	const urns = expectArray(cases?.[caseName], `the baseline of case "${caseName}"`);

	return(urns.map(function(urn) {
		return(expectString(urn, `a URN of case "${caseName}"`));
	}));
}

/**
 * The tree in the form that goes into a snapshot file: the project and
 * stack prefix every URN has is cut off, since it is the same in all of them
 */
export function describeTree(tree: TreeSnapshot): unknown {
	const prefix = `urn:pulumi:${tree.stack}::${tree.project}::`;
	const roots: [string, string][] = [ [ prefix, '' ] ];

	return(tree.resources.map(function(resource) {
		/* The dependencies are checked on their own; they would put a second copy of every URN into each snapshot */
		const kept = Object.entries(resource).filter(function([ key ]) {
			return(key !== 'dependsOn');
		});

		return(normalizeValue(Object.fromEntries(kept), roots));
	}));
}
