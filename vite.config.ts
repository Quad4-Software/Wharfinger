import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	// Vite 8 build-mode devtools (bundle/module inspection). Opt-in:
	// the analysis pass hangs on the fully-inlined SSR graph, so it
	// only runs with VITE_DEVTOOLS=1 pnpm build.
	devtools: { enabled: !!process.env.VITE_DEVTOOLS },
	// Inline all server dependencies so the production build/ directory is
	// fully self-contained and the runtime image needs no node_modules.
	// undici stays external: it is large, is only used for its Agent, and
	// the image copies it alongside ws for the server wrapper.
	ssr: {
		noExternal: true,
		external: ['undici']
	},
	build: {
		// Content-hashed assets get immutable caching; keep chunks small.
		target: 'es2022',
		cssCodeSplit: true,
		reportCompressedSize: false
	}
});
