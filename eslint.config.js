const js = require("@eslint/js");


module.exports = [
	js.configs.recommended,
	{
		files: ["**/*.js"],
		languageOptions: {
			ecmaVersion: 2021,
			sourceType: "module",
			globals: {
				// Define Node.js globals
				process: "readonly",
				console: "readonly",
				require: "readonly",
				module: "readonly",
				__dirname: "readonly",
				__filename: "readonly",
				setImmediate: "readonly",
				setTimeout: "readonly",
				Buffer: "readonly",
				URLSearchParams: "readonly",
				FormData: "readonly",
			},
		},
		rules: {
			"no-unused-vars": "warn",
			"no-console": "off",
			"no-unreachable": "error",
			"no-duplicate-case": "error",
		},
	},
	{
		files: ["**/*.test.js", "**/__tests__/**/*.js"],
		languageOptions: {
			ecmaVersion: 2021,
			sourceType: "module",
			globals: {
				// Jest globals
				describe: "readonly",
				test: "readonly",
				expect: "readonly",
				beforeEach: "readonly",
				afterEach: "readonly",
				beforeAll: "readonly",
				afterAll: "readonly",
				it: "readonly",
				jest: "readonly",
				// Node.js globals
				process: "readonly",
				console: "readonly",
				require: "readonly",
				module: "readonly",
				__dirname: "readonly",
				__filename: "readonly",
			},
		},
		rules: {
			"no-unused-vars": "warn",
			"no-console": "off",
		},
	},
];
