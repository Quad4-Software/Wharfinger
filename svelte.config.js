import { readFileSync } from 'node:fs';
import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter(),
		// App version feeds telemetry release tags and debug reports.
		version: { name: pkg.version },
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				'script-src': ['self'],
				// unsafe-inline required: Svelte keyed transitions and the
				// hydration payload inject style attributes.
				'style-src': ['self', 'unsafe-inline'],
				// blob: is needed for chat attachment image previews,
				// which are fetched as bytes and shown via object URLs
				// because the download route forces attachment disposition.
				'img-src': ['self', 'data:', 'blob:'],
				'font-src': ['self'],
				'connect-src': ['self'],
				'object-src': ['none'],
				'base-uri': ['none'],
				'form-action': ['self'],
				// Push notification service worker.
				'worker-src': ['self'],
				'frame-ancestors': ['none']
			}
		},
		output: {
			// Bundle runtime dependencies into build/ so the production
			// image needs no node_modules at all.
			bundleStrategy: 'single'
		}
	}
};

export default config;
