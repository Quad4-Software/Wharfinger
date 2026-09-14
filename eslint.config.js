import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import svelteParser from 'svelte-eslint-parser';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: [
			'build/',
			'.svelte-kit/',
			'.svelte-check/',
			'node_modules/',
			'coverage/',
			'playwright-report/',
			'test-results/',
			'pnpm-lock.yaml'
		]
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	...svelte.configs['flat/recommended'],
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node }
		}
	},
	{
		// Type-aware linting only where a tsconfig project exists.
		files: ['**/*.ts', '**/*.svelte'],
		extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.svelte']
			}
		},
		rules: {
			'@typescript-eslint/restrict-template-expressions': [
				'error',
				{ allowNumber: true, allowBoolean: false, allowAny: false }
			],
			// $bindable() props must live in a `let` destructure; flag a
			// destructure only when every member could be const.
			'prefer-const': ['error', { destructuring: 'all' }]
		}
	},
	{
		// Must come after the typed block: extends re-scopes the ts parser
		// onto .svelte files, so re-assert the svelte parser last.
		files: ['**/*.svelte'],
		languageOptions: {
			parser: svelteParser,
			parserOptions: {
				parser: tseslint.parser,
				extraFileExtensions: ['.svelte'],
				projectService: true,
				tsconfigRootDir: import.meta.dirname
			}
		}
	},
	{
		files: ['tests/**/*.ts'],
		rules: {
			'@typescript-eslint/no-non-null-assertion': 'off'
		}
	},
	{
		// The admin panel mount path is runtime-configurable, so hrefs
		// cannot be expressed as static route ids for resolve().
		files: ['src/routes/admin/**/*.svelte', 'src/lib/components/admin/**/*.svelte'],
		rules: {
			'svelte/no-navigation-without-resolve': 'off'
		}
	},
	prettier
);
