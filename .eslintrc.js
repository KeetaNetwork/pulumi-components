module.exports = {
    parserOptions: {
        project: './tsconfig.json',
    },
    extends: "@keetapay/eslint-config-typescript",
    rules: {
		'@typescript-eslint/no-inferrable-types': ['error', {
			'ignoreParameters': true
		}],
	},
}
