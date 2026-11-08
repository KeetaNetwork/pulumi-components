import fs from 'fs';
import { createRequire, registerHooks, type LoadHookSync, type ResolveHookSync } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

/*
 * Pulumi serializes the provider of a dynamic resource, and it finds the
 * built-in modules the provider captured by comparing them with what
 * `require()` returns. Vitest rewrites imports of `src` into module
 * namespace objects, which breaks that comparison. So tests that construct
 * dynamic resources load `src` through Node's own CommonJS loader, compiled
 * with the compiler options of "tsconfig.json" (target included).
 */

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceRequire = createRequire(path.join(repositoryRoot, 'package.json'));

function readCompilerOptions() {
	const config = ts.readConfigFile(path.join(repositoryRoot, 'tsconfig.json'), function(file) {
		return(ts.sys.readFile(file));
	});
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repositoryRoot);

	return({
		target: parsed.options.target,
		esModuleInterop: parsed.options.esModuleInterop,
		useDefineForClassFields: parsed.options.useDefineForClassFields,
		module: ts.ModuleKind.CommonJS
	});
}

const compilerOptions = readCompilerOptions();
const sourceDirectory = path.join(repositoryRoot, 'src') + path.sep;

function isSourceFile(filename: string) {
	return(filename.startsWith(sourceDirectory) && filename.endsWith('.ts'));
}

/** Resolves an extensionless import of a source file to the TypeScript file */
const resolveSource: ResolveHookSync = function(specifier, context, nextResolve) {
	try {
		return(nextResolve(specifier, context));
	} catch (error) {
		for (const suffix of [ '.ts', '/index.ts' ]) {
			try {
				return(nextResolve(specifier + suffix, context));
			} catch {
				/* Try the next suffix, then report the original failure */
			}
		}

		throw(error);
	}
};

/** Hands the compiled JavaScript of a source file to Node's CommonJS loader */
const loadSource: LoadHookSync = function(url, context, nextLoad) {
	if (!url.startsWith('file:') || !isSourceFile(fileURLToPath(url))) {
		return(nextLoad(url, context));
	}

	const filename = fileURLToPath(url);
	const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
		compilerOptions,
		fileName: filename
	});

	return({
		format: 'commonjs',
		source: compiled.outputText,
		shortCircuit: true
	});
};

/** Loads a module of this repository (path relative to the repository root) with `require()` */
export function requireSource<Exports>(relativePath: string): Exports {
	const hooks = registerHooks({ resolve: resolveSource, load: loadSource });

	try {
		return(sourceRequire(path.join(repositoryRoot, relativePath)));
	} finally {
		hooks.deregister();
	}
}
