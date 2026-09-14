import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, readJson } from '$lib/server/admin/http';
import { gate } from '$lib/server/ingress/http';
import { decodePubkey, verifyAgentSig } from '$lib/server/ingress/proof';

// WS handshake step 2: after the agent has verified the hub signature
// it sends its machine fingerprint and, on the current protocol, its
// identity pubkey plus a proof (ed25519 signature over the nonce
// issued by /ingress/handshake). The first fingerprint and the first
// proven pubkey bind the registration to that host and that key;
// later mismatches are rejected. A hello without a pubkey is a legacy
// agent: accepted during the compat window, left unbound, and marked
// legacy in the panel.
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const body = await readJson<{
		token?: unknown;
		fingerprint?: unknown;
		pubkey?: unknown;
		proof?: unknown;
	}>(event.request, 4096);
	const token = typeof body.token === 'string' ? body.token : null;
	const g = gate(rt, rt.agents, token);
	if (g.err) return g.err;

	const hasKey = body.pubkey !== undefined && body.pubkey !== null;
	// The challenge nonce is single-use: consume it on any keyed hello
	// regardless of outcome, so a captured (nonce, proof) pair cannot
	// be replayed later while the nonce still sits on the row.
	let nonce: Buffer | null = null;
	if (hasKey) {
		nonce = g.agent.bindNonce === null ? null : Buffer.from(g.agent.bindNonce, 'base64');
		rt.agents.clearBindNonce(g.agent.id);
	}

	const fp = typeof body.fingerprint === 'string' ? body.fingerprint.slice(0, 128) : '';
	const check = rt.agents.checkFingerprint(g.agent, fp);
	if (check === 'mismatch') {
		return apiError(403, 'fingerprint mismatch: this token is bound to another machine');
	}

	if (!hasKey) {
		// Legacy hello. A bound agent must always prove its key, so a
		// missing pubkey here is a downgrade or a stolen token.
		if (g.agent.pubkey !== null) {
			return apiError(403, 'agent key proof required: this registration is key-bound');
		}
		return apiJson({ ok: true, bound: check === 'bound', legacy: true, agent: { id: g.agent.id } });
	}

	const pubRaw = decodePubkey(body.pubkey);
	if (!pubRaw) return apiError(422, 'pubkey must be base64 raw 32 bytes');
	const pubB64 = pubRaw.toString('base64');

	if (nonce === null) {
		return apiError(403, 'missing challenge nonce: run the handshake first');
	}
	if (!verifyAgentSig(pubRaw, nonce, body.proof)) {
		return apiError(403, 'invalid key proof');
	}
	const keyCheck = rt.agents.checkPubkey(g.agent, pubB64);
	if (keyCheck === 'mismatch') {
		return apiError(403, 'agent key mismatch: this token is bound to another key');
	}
	return apiJson({
		ok: true,
		bound: check === 'bound',
		keybound: keyCheck === 'bound',
		agent: { id: g.agent.id }
	});
};
