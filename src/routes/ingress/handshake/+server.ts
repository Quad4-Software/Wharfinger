import { randomBytes } from 'node:crypto';
import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiJson, readJson } from '$lib/server/admin/http';
import { gate } from '$lib/server/ingress/http';
import { publicKeyB64, signToken } from '$lib/server/ingress/keys';

// WS handshake step 1 (Beszel model): the agent presents its
// registration token, the hub signs it with the hub ed25519 key. The
// agent verifies the signature against its pinned hub public key,
// proving it reached the real hub before sending anything else.
// The nonce is the per-connection proof-of-possession input: it is
// stored on the agent row and consumed by /ingress/hello, so a hello
// proof always covers a fresh hub-chosen value and cannot be replayed
// across connections.
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const body = await readJson<{ token?: unknown }>(event.request, 4096);
	const token = typeof body.token === 'string' ? body.token : null;
	const g = gate(rt, rt.agents, token);
	if (g.err) return g.err;
	const nonce = randomBytes(32).toString('base64');
	rt.agents.setBindNonce(g.agent.id, nonce);
	return apiJson({
		ok: true,
		signature: signToken(rt.db, token ?? ''),
		pub: publicKeyB64(rt.db),
		nonce
	});
};
