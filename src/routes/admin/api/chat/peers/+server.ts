import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiJson, requireUser } from '$lib/server/admin/http';
import type { ChatPeer } from '$lib/shared/chat';

// Lightweight user list for dm/room addressing; the full /users
// endpoint sits behind users.manage which chat must not require.
export const GET: RequestHandler = (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	const peers: ChatPeer[] = rt.users
		.all()
		.filter((u) => u.disabledAt === null && u.id !== user.id)
		.map((u) => ({
			id: u.id,
			username: u.username,
			displayName: u.displayName,
			hasAvatar: u.hasAvatar ?? false
		}));
	return apiJson({ peers });
};
