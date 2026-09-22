import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

type UpgradeHandler = (
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	internalBase: string
) => boolean;

// The production entry (server.js) attaches ws upgrade bridges for
// /ingress/ws and <admin>/chat/ws. In dev the vite server owns the
// socket, so the same bridges are attached here. Unclaimed upgrades
// fall through to vite's own HMR listener untouched.
function devWsBridges(): Plugin {
	return {
		name: 'wharfinger-ws-bridges',
		apply: 'serve',
		async configureServer(server) {
			const root = process.cwd();
			await import(pathToFileURL(join(root, 'server/bootstrap-env.mjs')).href);
			const chat = (await import(pathToFileURL(join(root, 'server/chat-ws.mjs')).href)) as {
				attachChatWs: () => void;
				handleChatUpgrade: UpgradeHandler;
			};
			const ingress = (await import(pathToFileURL(join(root, 'server/ingress-ws.mjs')).href)) as {
				handleIngressUpgrade: UpgradeHandler;
			};
			chat.attachChatWs();
			server.httpServer?.prependListener(
				'upgrade',
				(req: IncomingMessage, socket: Duplex, head: Buffer) => {
					// The bridges post back to this same server over loopback.
					// Vite may bind ::1 or a LAN address, so the internal base is
					// derived from the actual socket rather than hardcoding IPv4.
					const addr = server.httpServer?.address();
					const port = typeof addr === 'object' && addr ? addr.port : 5173;
					const bound = typeof addr === 'object' && addr ? addr.address : '';
					const host =
						!bound || bound === '0.0.0.0'
							? '127.0.0.1'
							: bound === '::'
								? '[::1]'
								: bound.includes(':')
									? `[${bound}]`
									: bound;
					const internalBase = `http://${host}:${port}`;
					if (ingress.handleIngressUpgrade(req, socket, head, internalBase)) return;
					if (chat.handleChatUpgrade(req, socket, head, internalBase)) return;
				}
			);
		}
	};
}

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), devWsBridges()],
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
		// web-push is CommonJS and vite's dev module-runner cannot
		// evaluate it inline. The production bundle inlines it fine via
		// the rollup CJS interop, so it only stays external in dev.
		external: ['undici', ...(process.env.NODE_ENV === 'development' ? ['web-push'] : [])]
	},
	build: {
		// Content-hashed assets get immutable caching; keep chunks small.
		target: 'es2022',
		cssCodeSplit: true,
		reportCompressedSize: false
	}
});
