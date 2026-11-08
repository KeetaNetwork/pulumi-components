import keetanetworkConfig from '@keetanetwork/eslint-config-typescript';

export default [
	...keetanetworkConfig,
	{
		files: ['**/*.ts'],
		rules: {
			'@typescript-eslint/no-unused-expressions': ['error', {
				allowShortCircuit: false,
				allowTernary: false,
				allowTaggedTemplates: false
			}]
		}
	},
	{
		// "tests" is outside the rootDir of "tsconfig.json", so type-aware
		// linting of it reads the test tsconfig. No rule changes.
		files: ['tests/**/*.ts'],
		languageOptions: {
			parserOptions: {
				project: './tsconfig.test.json'
			}
		}
	}
];
