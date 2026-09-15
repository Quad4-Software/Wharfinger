import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, requirePerm } from '$lib/server/admin/http';

async function userOr404(rt: ReturnType<typeof getRuntime>, raw: string) {
	const id = Number(raw);
	if (!Number.isInteger(id) || id <= 0) return null;
	return rt.users.byId(id);
}

/** List a user's sessions in the same shape the account page uses. */
export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	requirePerm(event, 'users.manage');
	const target = await userOr404(rt, event.params.id);
	if (!target) return apiError(404, 'unknown user');
	await audit(rt, event, 'users.sessions.view', `user=${target.username}`);
	const sessions = await rt.sessions.forUser(target.id, event.locals.sessionHash ?? undefined);
	return apiJson({
		sessions: sessions.map((s) => ({
			hash: s.tokenHash.slice(0, 16),
			createdAt: s.createdAt,
			expiresAt: s.expiresAt,
			lastSeenAt: s.lastSeenAt,
			ip: s.ip,
			userAgent: s.userAgent,
			current: s.current ?? false
		}))
	});
};

/** Revoke every session for a user; the caller's own session survives. */
export const DELETE: RequestHandler = async (event) => {
	const rt = getRuntime();
	requirePerm(event, 'users.manage');
	const target = await userOr404(rt, event.params.id);
	if (!target) return apiError(404, 'unknown user');
	await rt.sessions.revokeUserSessions(target.id, event.locals.sessionHash ?? undefined);
	await audit(rt, event, 'users.session.revoke_all', `user=${target.username}`);
	return apiJson({ ok: true });
};
