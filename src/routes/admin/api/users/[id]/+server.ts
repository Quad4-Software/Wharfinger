import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, asString, readJson, requirePerm } from '$lib/server/admin/http';
import { canGrantRole } from '$lib/server/admin/authz';
import type { Role } from '$lib/server/admin/users';

function userOr404(rt: ReturnType<typeof getRuntime>, raw: string) {
	const id = Number(raw);
	if (!Number.isInteger(id) || id <= 0) return null;
	return rt.users.byId(id);
}

function lastAdmin(rt: ReturnType<typeof getRuntime>, excludeId: number): boolean {
	return rt.users.admins().filter((a) => a.id !== excludeId && a.disabledAt === null).length === 0;
}

/** Update role, display name, or disabled state. */
export const PATCH: RequestHandler = async (event) => {
	const rt = getRuntime();
	const actor = requirePerm(event, 'users.manage');
	const target = userOr404(rt, event.params.id);
	if (!target) return apiError(404, 'unknown user');
	const body = await readJson<{
		role?: unknown;
		display_name?: unknown;
		disabled?: unknown;
	}>(event.request, 8192);

	if (body.role !== undefined) {
		if (typeof body.role !== 'string' || !rt.roles.exists(body.role)) {
			return apiError(422, 'unknown role');
		}
		const role: Role = body.role;
		if (!canGrantRole(rt.roles, event.locals.perms, role)) {
			return apiError(403, 'you cannot grant a role with permissions you do not hold');
		}
		if (target.id === actor.id && role !== 'admin') {
			return apiError(422, 'you cannot demote yourself');
		}
		if (target.role === 'admin' && role !== 'admin' && lastAdmin(rt, target.id)) {
			return apiError(422, 'cannot demote the last admin');
		}
		rt.users.setRole(target.id, role);
		if (role !== 'admin') rt.sessions.revokeUserSessions(target.id);
		audit(rt, event, 'users.role', `user=${target.username} role=${role}`);
	}

	if (body.display_name !== undefined) {
		rt.users.setDisplayName(target.id, asString(body.display_name, 80) ?? '');
		audit(rt, event, 'users.rename', `user=${target.username}`);
	}

	if (typeof body.disabled === 'boolean') {
		if (target.id === actor.id && body.disabled) {
			return apiError(422, 'you cannot disable your own account');
		}
		if (body.disabled && target.role === 'admin' && lastAdmin(rt, target.id)) {
			return apiError(422, 'cannot disable the last admin');
		}
		rt.users.setDisabled(target.id, body.disabled);
		if (body.disabled) rt.sessions.revokeUserSessions(target.id);
		audit(rt, event, body.disabled ? 'users.disable' : 'users.enable', `user=${target.username}`);
	}

	return apiJson({ ok: true, user: rt.users.byId(target.id) });
};

export const DELETE: RequestHandler = (event) => {
	const rt = getRuntime();
	const actor = requirePerm(event, 'users.manage');
	const target = userOr404(rt, event.params.id);
	if (!target) return apiError(404, 'unknown user');
	if (target.id === actor.id) return apiError(422, 'you cannot delete your own account');
	if (target.role === 'admin' && lastAdmin(rt, target.id)) {
		return apiError(422, 'cannot delete the last admin');
	}
	rt.sessions.revokeUserSessions(target.id);
	rt.invites.revokeForUser(target.id);
	rt.users.remove(target.id);
	audit(rt, event, 'users.delete', `user=${target.username}`);
	return apiJson({ ok: true });
};
