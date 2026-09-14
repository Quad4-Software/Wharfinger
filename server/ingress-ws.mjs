import { WebSocketServer } from 'ws';

// WebSocket ingress bridge. Auth and ingest logic all live in the
// SvelteKit /ingress routes; this file only adapts the ws framing to
// loopback HTTP calls, so there is a single implementation to audit.
//
// Protocol (agent side mirrors this in agent/internal/send/ws.go):
//   upgrade   Bearer token in the Authorization header
//   hub  ->   { type: "challenge", signature, nonce }
//             signature = ed25519 sig over token, nonce = per-connection
//             proof-of-possession input (base64, hub-generated)
//   agent ->  { type: "hello", fingerprint, v, pubkey, proof }
//             pubkey = base64 raw 32B agent identity key,
//             proof = ed25519 sig over the raw nonce bytes
//   hub  ->   { type: "ready" } | { type: "error", error }
//   agent ->  { type: "metrics", data, pubkey, proof }   (repeating)
//             v2 agents send data as a JSON string and proof as a sig
//             over those exact bytes; the bridge forwards them as the
//             raw POST body with x-agent-* headers so the REST ingress
//             verifies the same proof end to end. Legacy agents send
//             data as an object with no proof.

const MAX_INFLIGHT = 8;
const HELLO_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 30_000;
const IDLE_CLOSE_MS = 120_000;

async function post(base, path, body, headers = {}) {
	const res = await fetch(`${base}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		// A string body is forwarded verbatim: metrics proofs sign the
		// exact bytes, so reserializing would break verification.
		body: typeof body === 'string' ? body : JSON.stringify(body),
		signal: AbortSignal.timeout(10_000)
	});
	return { status: res.status, body: await res.json().catch(() => ({})) };
}

function send(ws, msg) {
	if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function closeError(ws, error) {
	send(ws, { type: 'error', error });
	ws.close(1008, 'handshake failed');
}

/** One next-text-message awaiter with timeout. */
function nextMessage(ws, timeoutMs) {
	return new Promise((resolve, reject) => {
		const onMsg = (data) => {
			done();
			try {
				resolve(JSON.parse(data.toString()));
			} catch {
				reject(new Error('bad json'));
			}
		};
		const onClose = () => {
			done();
			reject(new Error('closed'));
		};
		const done = () => {
			clearTimeout(timer);
			ws.off('message', onMsg);
			ws.off('close', onClose);
		};
		const timer = setTimeout(() => {
			done();
			reject(new Error('timeout'));
		}, timeoutMs);
		ws.once('message', onMsg);
		ws.once('close', onClose);
	});
}

async function handleAgent(ws, token, base) {
	// Handshake step 1: token -> hub signature.
	let hs;
	try {
		hs = await post(base, '/ingress/handshake', { token });
	} catch {
		return closeError(ws, 'hub unavailable');
	}
	if (hs.status !== 200) return closeError(ws, 'unauthorized');
	send(ws, { type: 'challenge', signature: hs.body.signature, nonce: hs.body.nonce });

	// Step 2: hello with the machine fingerprint and, on the current
	// protocol, the agent identity pubkey plus a proof over the nonce.
	let hello;
	try {
		hello = await nextMessage(ws, HELLO_TIMEOUT_MS);
	} catch {
		return closeError(ws, 'hello timeout');
	}
	if (hello?.type !== 'hello' || typeof hello.fingerprint !== 'string') {
		return closeError(ws, 'expected hello');
	}
	const helloBody = {
		token,
		fingerprint: hello.fingerprint.slice(0, 128)
	};
	if (typeof hello.pubkey === 'string') helloBody.pubkey = hello.pubkey;
	if (typeof hello.proof === 'string') helloBody.proof = hello.proof;
	let bound;
	try {
		bound = await post(base, '/ingress/hello', helloBody);
	} catch {
		return closeError(ws, 'hub unavailable');
	}
	if (bound.status !== 200) {
		return closeError(ws, bound.body?.error ?? 'rejected');
	}
	send(ws, { type: 'ready' });

	// Metrics loop: every frame is validated by POST /ingress so the ws
	// path can never bypass schema checks or fingerprint binding.
	let inFlight = 0;
	ws.on('message', (data) => {
		if (inFlight >= MAX_INFLIGHT) {
			ws.close(1008, 'backpressure');
			return;
		}
		let msg;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			return;
		}
		if (msg?.type !== 'metrics' || msg.data == null) return;
		inFlight++;
		const headers = { authorization: `Bearer ${token}` };
		// Signed frames (data as a JSON string) carry the proof the REST
		// ingress verifies over the raw body. Legacy object frames go
		// through unproven, same as a pre-keypair agent posting direct.
		if (typeof msg.data === 'string') {
			if (typeof msg.pubkey === 'string') headers['x-agent-pubkey'] = msg.pubkey;
			if (typeof msg.proof === 'string') headers['x-agent-proof'] = msg.proof;
		}
		post(base, '/ingress', msg.data, headers)
			.then((r) => {
				if (r.status === 401 || r.status === 403) {
					closeError(ws, r.body?.error ?? 'authorization lost');
				} else if (r.status !== 200) {
					send(ws, { type: 'error', error: r.body?.error ?? 'ingest failed' });
				}
			})
			.catch(() => send(ws, { type: 'error', error: 'hub unavailable' }))
			.finally(() => {
				inFlight--;
			});
	});
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

/**
 * Claim a single upgrade request when it targets /ingress/ws. Returns
 * true when the socket was handled (upgraded or rejected); server.js
 * dispatches to this first so other ws endpoints can share the server.
 * `base` is the loopback http URL the bridge posts to (same process).
 */
export function handleIngressUpgrade(req, socket, head, base) {
	let pathname;
	try {
		pathname = new URL(req.url ?? '/', 'http://internal').pathname;
	} catch {
		return false;
	}
	if (pathname !== '/ingress/ws') return false;
	const auth = req.headers.authorization;
	const token =
		typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
	if (!token) {
		socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
		socket.destroy();
		return true;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		const ping = setInterval(() => {
			if (ws.readyState === ws.OPEN) ws.ping();
		}, PING_INTERVAL_MS);
		ping.unref();
		const idle = setTimeout(() => ws.terminate(), IDLE_CLOSE_MS);
		idle.unref();
		ws.on('pong', () => idle.refresh());
		ws.on('close', () => {
			clearInterval(ping);
			clearTimeout(idle);
		});
		handleAgent(ws, token, base).catch(() => ws.close(1011));
	});
	return true;
}
