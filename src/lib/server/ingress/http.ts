import { apiError } from '../admin/http';
import type { AgentRow, AgentStore } from './agents';
import { decodePubkey, verifyAgentSig } from './proof';
import type { Runtime } from '../runtime';

export function bearerToken(request: Request): string | null {
	const h = request.headers.get('authorization');
	if (!h?.startsWith('Bearer ')) return null;
	const t = h.slice(7).trim();
	return t || null;
}

export interface ResolvedAgent extends AgentRow {
	tokenHash: string;
}

/**
 * Shared gate for every ingress endpoint: section enabled, token
 * resolves to a live agent. Returns either an error Response or the
 * resolved agent.
 */
export function gate(
	rt: Runtime,
	agents: AgentStore,
	token: string | null
): { err: Response } | { err: null; agent: ResolvedAgent } {
	if (!rt.config.ingress.enabled) return { err: apiError(404, 'not found') };
	if (!token) return { err: apiError(401, 'missing bearer token') };
	const agent = agents.resolveToken(token);
	if (!agent) return { err: apiError(401, 'invalid token') };
	return { err: null, agent };
}

/**
 * Key proof gate shared by every agent endpoint that carries a body.
 * Once an agent's pubkey is bound, every request must carry
 * x-agent-pubkey plus x-agent-proof (ed25519 signature over the exact
 * request body) so a stolen bearer token alone cannot act. An unbound
 * agent presenting a valid proof gets its key bound (TOFU, same
 * moment the fingerprint binds); an unbound agent with no proof
 * headers is a legacy client accepted during the compat window.
 */
export function proofGate(
	rt: Runtime,
	agent: { id: string; pubkey: string | null },
	request: Request,
	bodyBytes: Buffer
): Response | null {
	const pubHdr = request.headers.get('x-agent-pubkey');
	const proofHdr = request.headers.get('x-agent-proof');
	if (agent.pubkey !== null) {
		if (pubHdr !== agent.pubkey) {
			return apiError(403, 'agent key proof required: this registration is key-bound');
		}
		if (!verifyAgentSig(Buffer.from(agent.pubkey, 'base64'), bodyBytes, proofHdr)) {
			return apiError(403, 'invalid agent key proof');
		}
		return null;
	}
	if (pubHdr === null && proofHdr === null) return null; // legacy client
	// A proof without its pubkey is a malformed registration attempt.
	if (pubHdr === null) return apiError(403, 'invalid agent key proof');
	const pubRaw = decodePubkey(pubHdr);
	if (!pubRaw || !verifyAgentSig(pubRaw, bodyBytes, proofHdr)) {
		return apiError(403, 'invalid agent key proof');
	}
	// First valid proof binds the key (TOFU); the conditional update
	// inside checkPubkey makes concurrent first posts safe.
	const bound = rt.agents.checkPubkey(agent as AgentRow, pubHdr);
	if (bound === 'mismatch') {
		return apiError(403, 'agent key mismatch: this token is bound to another key');
	}
	return null;
}
