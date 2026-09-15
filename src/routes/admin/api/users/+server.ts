import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import type { Role } from '$lib/server/admin/users';
import { apiError, apiJson, audit, asString, readJson, requirePerm } from '$lib/server/admin/http';
import { canGrantRole } from '$lib/server/admin/authz';
import { USERNAME_RE, checkPassword } from '$lib/server/admin/policy';

export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	requirePerm(event, 'users.manage');
	return apiJson({ users: await rt.users.all() });
};

/** Create an account directly (invites are the usual path). */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const actor = requirePerm(event, 'users.manage');
	const body = await readJson<{
		username?: unknown;
		display_name?: unknown;
		password?: unknown;
		role?: unknown;
	}>(event.request, 8192);

	const username = typeof body.username === 'string' ? body.username.trim() : '';
	const displayName = asString(body.display_name, 80) ?? '';
	const password = typeof body.password === 'string' ? body.password : '';
	if (typeof body.role !== 'string' || !(await rt.roles.exists(body.role))) {
		return apiError(422, 'unknown role');
	}
	if (!(await canGrantRole(rt.roles, event.locals.perms, body.role))) {
		return apiError(403, 'you cannot grant a role with permissions you do not hold');
	}
	const role: Role = body.role;
	if (!USERNAME_RE.test(username)) {
		return apiError(422, 'username must be 2-64 chars of a-z, 0-9, dot, dash, underscore');
	}
	const pwError = checkPassword(password, username, rt.config.admin.password_min_length);
	if (pwError) return apiError(422, pwError);
	if (await rt.users.rowByName(username)) return apiError(409, 'that username is taken');

	const user = await rt.users.create(username, password, role, displayName);
	await audit(rt, event, 'users.create', `username=${username} role=${role} by=${actor.username}`);
	return apiJson({ ok: true, user }, 201);
};
