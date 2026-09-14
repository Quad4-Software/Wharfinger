import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, requirePerm } from '$lib/server/admin/http';
import { hashToken, newToken } from '$lib/server/ingress/agents';
import { publicKeyB64 } from '$lib/server/ingress/keys';

/** Rotate the bearer token. The fingerprint and identity-key bindings
 * are cleared so a replacement host (or a rotated/lost agent key) can
 * re-register; the new token is returned once. */
export const POST: RequestHandler = (event) => {
	const rt = getRuntime();
	requirePerm(event, 'agents.manage');
	const agent = rt.agents.get(event.params.id);
	if (!agent) return apiError(404, 'agent not found');
	const token = newToken();
	rt.db
		.prepare(
			'UPDATE agents SET token_hash = ?, fingerprint = NULL, pubkey = NULL, bind_nonce = NULL, revoked_at = NULL WHERE id = ?'
		)
		.run(hashToken(token), agent.id);
	audit(rt, event, 'agents.rotate', `id=${agent.id} name=${agent.name}`);
	return apiJson({ token, pubkey: publicKeyB64(rt.db) });
};
