import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiJson } from '$lib/server/admin/http';
import { publicKeyInfo } from '$lib/server/ingress/keys';

// Hub public key for agent KEY configuration. Public information;
// verifying with it is what proves hub identity during the handshake.
// After a hub key rotation the response also carries prev_pub,
// rotated_at, and proof (the previous key's signature over the new
// pubkey) so pinned agents can adopt the new key.
export const GET: RequestHandler = () => {
	const rt = getRuntime();
	return apiJson(publicKeyInfo(rt.db));
};
