import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, requirePerm } from '$lib/server/admin/http';

/** Admin moderation: clear another user's avatar. */
export const DELETE: RequestHandler = async (event) => {
	requirePerm(event, 'users.manage');
	const rt = getRuntime();
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0 || !(await rt.users.byId(id))) {
		return apiError(404, 'unknown user');
	}
	await rt.users.clearAvatar(id);
	await audit(rt, event, 'users.avatar.remove', `user ${id}`);
	return apiJson({ ok: true });
};
