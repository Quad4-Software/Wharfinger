import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { verifyPassword } from '$lib/server/admin/crypto';
import { checkPassword } from '$lib/server/admin/policy';
import { apiError, apiJson, audit, asString, readJson, requireUser } from '$lib/server/admin/http';

export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	const sessions = await rt.sessions.forUser(user.id, event.locals.sessionHash ?? undefined);
	return apiJson({
		user,
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

/** Change display name or password (password requires the current one). */
export const PATCH: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	const body = await readJson<{
		display_name?: unknown;
		current_password?: unknown;
		new_password?: unknown;
	}>(event.request, 8192);

	if (body.display_name !== undefined) {
		await rt.users.setDisplayName(user.id, asString(body.display_name, 80) ?? '');
		await audit(rt, event, 'account.rename');
	}

	if (body.new_password !== undefined) {
		const current = typeof body.current_password === 'string' ? body.current_password : '';
		const next = typeof body.new_password === 'string' ? body.new_password : '';
		const row = await rt.users.rowById(user.id);
		if (!row || !verifyPassword(current, row.password_hash)) {
			await audit(rt, event, 'account.password.fail');
			return apiError(403, 'current password is incorrect');
		}
		const pwError = checkPassword(next, user.username, rt.config.admin.password_min_length);
		if (pwError) return apiError(422, pwError);
		await rt.users.setPassword(user.id, next);
		await rt.sessions.revokeUserSessions(user.id, event.locals.sessionHash ?? undefined);
		await audit(rt, event, 'account.password');
	}

	return apiJson({ ok: true, user: await rt.users.byId(user.id) });
};
