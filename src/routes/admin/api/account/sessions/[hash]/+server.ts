import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, requireUser } from '$lib/server/admin/http';

/** Revoke one of the caller's own sessions by hash prefix. */
export const DELETE: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	const prefix = event.params.hash;
	const match = (await rt.sessions.forUser(user.id)).find((s) => s.tokenHash.startsWith(prefix));
	if (!match) return apiError(404, 'unknown session');
	await rt.sessions.revoke(match.tokenHash);
	await audit(rt, event, 'account.session.revoke', match.current ? 'current' : undefined);
	return apiJson({ ok: true });
};
