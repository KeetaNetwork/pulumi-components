import * as grpc from '@grpc/grpc-js';
import * as pulumi from '@pulumi/pulumi';
import * as engineGrpc from '@pulumi/pulumi/proto/engine_grpc_pb.js';
import * as engineProto from '@pulumi/pulumi/proto/engine_pb.js';
import { Empty } from 'google-protobuf/google/protobuf/empty_pb.js';

/**
 * An engine that only takes log messages. Pulumi's runtime sends every
 * `pulumi.log` call to the engine it is connected to, so the messages are
 * read where the engine would read them.
 */
async function startLogEngine() {
	const messages: { severity: engineProto.LogSeverity; message: string }[] = [];
	const server = new grpc.Server();
	server.addService(engineGrpc.EngineService, {
		log: function(call: grpc.ServerUnaryCall<engineProto.LogRequest, Empty>, callback: grpc.sendUnaryData<Empty>) {
			messages.push({ severity: call.request.getSeverity(), message: call.request.getMessage() });
			callback(null, new Empty());
		}
	});

	const port = await new Promise<number>(function(resolve, reject) {
		server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), function(err, boundPort) {
			if (err !== null) {
				reject(err);
			} else {
				resolve(boundPort);
			}
		});
	});

	return({ address: `127.0.0.1:${port}`, messages, server });
}

/**
 * Connects the Pulumi runtime to an engine, or to none with an empty address.
 * The project and stack are those `captureTree` uses, which sets up its
 * monitor after this and keeps the engine.
 */
function connectEngine(address: string) {
	pulumi.runtime.resetOptions('project', 'stack', -1, address, '', false, '');
}

/**
 * Runs `run` with the Pulumi runtime connected to a log engine, and returns
 * what it returned with the warnings the library logged until it settled
 */
export async function captureWarnings<Result>(run: () => Result | Promise<Result>) {
	const engine = await startLogEngine();
	connectEngine(engine.address);
	try {
		const result = await run();

		/* Log messages are delivered in order, so this one arriving means every earlier one has */
		await pulumi.log.debug('end of the captured warnings');

		const warnings = engine.messages.filter(function(entry) {
			return(entry.severity === engineProto.LogSeverity.WARNING);
		}).map(function(entry) {
			return(entry.message);
		});

		return({ result, warnings });
	} finally {
		connectEngine('');
		engine.server.forceShutdown();
	}
}
