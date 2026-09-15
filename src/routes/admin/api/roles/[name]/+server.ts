import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { parsePermissions } from '$lib/server/admin/roles';
import { apiError, apiJson, asString, audit, readJson, requirePerm } from '$lib/server/admin/http';

export const PATCH: RequestHandler = async (event) => {
	const rt = getRuntime();
	requirePerm(event, 'roles.manage');
	const { name } = event.params;
	const existing = await rt.roles.get(name);
	if (!existing) return apiError(404, 'unknown role');
	const body = await readJson<{ label?: unknown; permissions?: unknown }>(event.request, 8192);
	const label =
		body.label === undefined ? existing.label : (asString(body.label, 80) ?? existing.label);
	const permissions =
		body.permissions === undefined ? existing.permissions : parsePermissions(body.permissions);
	if (!permissions) {
		return apiError(422, 'permissions must be an array of known permission names');
	}
	const res = await rt.roles.update(name, label, permissions);
	if (res === 'protected') return apiError(422, 'the admin role cannot be modified');
	if (res === 'missing') return apiError(404, 'unknown role');
	await audit(rt, event, 'roles.update', `name=${name} perms=${permissions.join(',')}`);
	return apiJson({ role: await rt.roles.get(name) });
};

export const DELETE: RequestHandler = async (event) => {
	const rt = getRuntime();
	requirePerm(event, 'roles.manage');
	const res = await rt.roles.remove(event.params.name);
	if (res === 'missing') return apiError(404, 'unknown role');
	if (res === 'protected') return apiError(422, 'built-in roles cannot be deleted');
	if (res === 'in_use') {
		return apiError(409, 'role is still assigned to users; reassign them first');
	}
	await audit(rt, event, 'roles.delete', `name=${event.params.name}`);
	return apiJson({ ok: true });
};
