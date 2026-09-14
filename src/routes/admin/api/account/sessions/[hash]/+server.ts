import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, requireUser } from '$lib/server/admin/http';

/** Revoke one of the caller's own sessions by hash prefix. */
export const DELETE: RequestHandler = (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	const prefix = event.params.hash;
	const match = rt.sessions.forUser(user.id).find((s) => s.tokenHash.startsWith(prefix));
	if (!match) return apiError(404, 'unknown session');
	rt.sessions.revoke(match.tokenHash);
	audit(rt, event, 'account.session.revoke', match.current ? 'current' : undefined);
	return apiJson({ ok: true });
};
