import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, requirePerm } from '$lib/server/admin/http';

/** Admin moderation: clear another user's avatar. */
export const DELETE: RequestHandler = (event) => {
	requirePerm(event, 'users.manage');
	const rt = getRuntime();
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0 || !rt.users.byId(id)) {
		return apiError(404, 'unknown user');
	}
	rt.users.clearAvatar(id);
	audit(rt, event, 'users.avatar.remove', `user ${id}`);
	return apiJson({ ok: true });
};
