import * as pulumi from '@pulumi/pulumi';
import { vi } from 'vitest';

/** Replaces `pulumi.log.warn` for as long as `run` takes, and gives the messages it was called with */
function watchWarnings() {
	const spy = vi.spyOn(pulumi.log, 'warn').mockImplementation(function() {
		return(Promise.resolve());
	});

	return({
		messages: function() {
			return(spy.mock.calls.map(function([ message ]) {
				return(String(message));
			}));
		},
		stop: function() {
			spy.mockRestore();
		}
	});
}

/** Runs `run` and returns what it returned with the warnings that the library logged meanwhile */
export function captureWarnings<Result>(run: () => Result) {
	const watch = watchWarnings();
	try {
		const result = run();

		return({ result, warnings: watch.messages() });
	} finally {
		watch.stop();
	}
}

/** The same for a function that returns a promise: the warnings are those logged until it settles */
export async function captureWarningsAsync<Result>(run: () => Promise<Result>) {
	const watch = watchWarnings();
	try {
		const result = await run();

		return({ result, warnings: watch.messages() });
	} finally {
		watch.stop();
	}
}
