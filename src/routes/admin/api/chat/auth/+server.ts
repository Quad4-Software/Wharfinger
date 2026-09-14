import type { RequestHandler } from './$types';
import { apiJson, requireUser } from '$lib/server/admin/http';
import { requireChatBridge } from '$lib/server/admin/chat';

// Bridge-only handshake endpoint: the ws upgrade forwards the
// client cookie so the same session resolution the panel uses
// vouches for the socket identity. Loopback + shared token only.
export const POST: RequestHandler = (event) => {
	requireChatBridge(event);
	const user = requireUser(event);
	return apiJson({
		id: user.id,
		username: user.username,
		displayName: user.displayName,
		hasAvatar: user.hasAvatar ?? false
	});
};
