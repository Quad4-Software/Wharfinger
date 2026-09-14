import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiJson, audit, requireUser } from '$lib/server/admin/http';

/** Revoke every session except the caller's current one. */
export const DELETE: RequestHandler = (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	rt.sessions.revokeUserSessions(user.id, event.locals.sessionHash ?? undefined);
	audit(rt, event, 'account.session.revoke_all');
	return apiJson({ ok: true });
};
