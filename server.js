import './server/bootstrap-env.mjs';
import { createServer } from 'node:http';
import { handler } from './build/handler.js';
import { handleIngressUpgrade } from './server/ingress-ws.mjs';
import { attachChatWs, closeChatWs, handleChatUpgrade } from './server/chat-ws.mjs';

// Production entry: adapter-node's http handler plus ws upgrade
// bridges for /ingress/ws and <adminBase>/chat/ws. Both bridges
// authenticate and mutate by posting to the same SvelteKit routes on
// loopback, so security logic is never duplicated. PORT/HOST follow
// adapter-node conventions.

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const internalBase = `http://127.0.0.1:${port}`;

// Forwarded headers are only trusted when the deployment opts in via
// WHARFINGER_TRUST_PROXY, matching the XFF rule in hooks.server.ts. Without
// the gate a direct client could forge X-Forwarded-Proto and flip the
// session cookie Secure flag in either direction.
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.WHARFINGER_TRUST_PROXY ?? '');

const server = createServer((req, res) => {
	// Stamp the real protocol so event.url and isSecureRequest see the
	// truth on every topology. A client-supplied copy is dropped first;
	// a forwarded proto is honored only in a trusted-proxy deployment.
	delete req.headers['x-wharfinger-proto'];
	const fwd = TRUST_PROXY ? req.headers['x-forwarded-proto'] : undefined;
	req.headers['x-wharfinger-proto'] =
		typeof fwd === 'string' && fwd.length > 0
			? fwd.split(',')[0].trim()
			: req.socket.encrypted
				? 'https'
				: 'http';
	handler(req, res, () => {
		res.writeHead(404).end('not found');
	});
});

// One upgrade dispatch: each bridge claims only its own path and
// unclaimed sockets die, so a stray Upgrade request cannot linger.
server.on('upgrade', (req, socket, head) => {
	if (handleIngressUpgrade(req, socket, head, internalBase)) return;
	if (handleChatUpgrade(req, socket, head, internalBase)) return;
	socket.destroy();
});

// Registers the chat bus emitter, heartbeat, and presence sweep; the
// upgrade claim happens in the dispatch above.
attachChatWs();

server.listen(port, host, () => {
	console.log(
		`[wharfinger] listening on ${host}:${port} (ws ingress at /ingress/ws, chat at <admin>/chat/ws)`
	);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
	process.on(sig, () => {
		closeChatWs();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 5000).unref();
	});
}
