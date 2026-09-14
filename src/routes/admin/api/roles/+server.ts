import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { ALL_PERMISSIONS } from '$lib/server/admin/authz';
import { ROLE_NAME_RE, parsePermissions } from '$lib/server/admin/roles';
import { apiError, apiJson, asString, audit, readJson, requirePerm } from '$lib/server/admin/http';

export const GET: RequestHandler = (event) => {
	const rt = getRuntime();
	requirePerm(event, 'roles.manage');
	return apiJson({
		roles: rt.roles.list().map((r) => ({ ...r, members: rt.users.countByRole(r.name) })),
		permissions: ALL_PERMISSIONS
	});
};

export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	requirePerm(event, 'roles.manage');
	const body = await readJson<{ name?: unknown; label?: unknown; permissions?: unknown }>(
		event.request,
		8192
	);
	const name = typeof body.name === 'string' ? body.name.trim() : '';
	if (!ROLE_NAME_RE.test(name)) {
		return apiError(422, 'name must start with a letter, then a-z, 0-9, dash, underscore (max 32)');
	}
	const label = asString(body.label, 80) ?? name;
	const permissions = parsePermissions(body.permissions);
	if (!permissions) {
		return apiError(422, 'permissions must be an array of known permission names');
	}
	if (rt.roles.exists(name)) return apiError(409, 'a role with that name already exists');
	const role = rt.roles.create(name, label, permissions);
	audit(rt, event, 'roles.create', `name=${name} perms=${permissions.join(',')}`);
	return apiJson({ role }, 201);
};
