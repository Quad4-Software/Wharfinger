import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiJson, audit, requirePerm } from '$lib/server/admin/http';
import { rotateHubKey } from '$lib/server/ingress/keys';

// Rotate the hub ed25519 identity. The previous public key signs the
// new one (the stored proof), so agents pinned to it adopt the new
// key automatically on their next handshake failure; agents pinned to
// anything older need a manual re-pin. Push tokens are unaffected:
// they derive from a separate stable secret.
export const POST: RequestHandler = async (event) => {
	requirePerm(event, 'agents.manage');
	const rt = getRuntime();
	const info = await rotateHubKey(rt.db);
	await audit(rt, event, 'agents.rotate_hub_key', `pub=${info.pub.slice(0, 16)}...`);
	return apiJson(info);
};
