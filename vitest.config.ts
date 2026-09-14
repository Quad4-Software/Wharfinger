import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [svelte(), svelteTesting()],
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
			'$app/environment': fileURLToPath(
				new URL('./tests/mocks/app-environment.ts', import.meta.url)
			),
			'$app/paths': fileURLToPath(new URL('./tests/mocks/app-paths.ts', import.meta.url)),
			'$app/state': fileURLToPath(new URL('./tests/mocks/app-state.ts', import.meta.url))
		}
	},
	test: {
		coverage: {
			provider: 'v8',
			reporter: ['text', 'html'],
			include: ['src/lib/**'],
			exclude: ['src/lib/components/**'],
			// Ratchet floor: may only move upward. See
			// .agents/rules/testing.md.
			thresholds: {
				lines: 55,
				branches: 50,
				functions: 55,
				statements: 55
			}
		},
		projects: [
			{
				test: {
					name: 'server',
					environment: 'node',
					include: ['tests/unit/**/*.test.ts']
				}
			},
			{
				test: {
					name: 'component',
					environment: 'jsdom',
					include: ['tests/component/**/*.test.ts'],
					setupFiles: ['tests/component/setup.ts']
				}
			}
		]
	}
});
