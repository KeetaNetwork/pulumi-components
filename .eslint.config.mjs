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
	}
];
