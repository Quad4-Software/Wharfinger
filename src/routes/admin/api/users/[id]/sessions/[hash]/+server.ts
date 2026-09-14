import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, requirePerm } from '$lib/server/admin/http';

/** Revoke one session of a user by the hash prefix shown in the UI. */
export const DELETE: RequestHandler = (event) => {
	const rt = getRuntime();
	requirePerm(event, 'users.manage');
	const id = Number(event.params.id);
	const target = Number.isInteger(id) && id > 0 ? rt.users.byId(id) : null;
	if (!target) return apiError(404, 'unknown user');
	const prefix = event.params.hash;
	// Same floor as invites/[hash]: a tiny prefix must not match an
	// arbitrary session.
	if (prefix.length < 8) return apiError(422, 'hash prefix too short');
	const match = rt.sessions
		.forUser(target.id, event.locals.sessionHash ?? undefined)
		.find((s) => s.tokenHash.startsWith(prefix));
	if (!match) return apiError(404, 'unknown session');
	rt.sessions.revoke(match.tokenHash);
	audit(
		rt,
		event,
		'users.session.revoke',
		`user=${target.username}${match.current ? ' current' : ''}`
	);
	return apiJson({ ok: true });
};
