import fs from 'fs';
import { createRequire } from 'module';
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
	const config = ts.readConfigFile(path.join(repositoryRoot, 'tsconfig.json'), ts.sys.readFile);
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repositoryRoot);

	return({
		target: parsed.options.target,
		esModuleInterop: parsed.options.esModuleInterop,
		useDefineForClassFields: parsed.options.useDefineForClassFields,
		module: ts.ModuleKind.CommonJS
	});
}

function compileTypeScript(module: NodeModule, filename: string) {
	const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
		compilerOptions: readCompilerOptions(),
		fileName: filename
	});

	if (!('_compile' in module) || typeof module._compile !== 'function') {
		throw(new Error('Node module loader has no _compile'));
	}

	Reflect.apply(module._compile, module, [ compiled.outputText, filename ]);
}

/** Loads a module of this repository (path relative to the repository root) with `require()` */
export function requireSource<Exports>(relativePath: string): Exports {
	sourceRequire.extensions['.ts'] ??= compileTypeScript;

	return(sourceRequire(path.join(repositoryRoot, relativePath)));
}
