import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { getGroupStore, GroupError } from '$lib/server/groups/store';

interface PatchBody {
	name?: unknown;
	color?: unknown;
}

export const PATCH: RequestHandler = async (event) => {
	requirePerm(event, 'groups.manage');
	const rt = getRuntime();
	const id = event.params.id;
	const body = await readJson<PatchBody>(event.request, 8192);

	const patch: { name?: string; color?: string | null } = {};
	if (body.name !== undefined) {
		if (typeof body.name !== 'string') return apiError(422, 'name must be a string');
		patch.name = body.name;
	}
	if (body.color !== undefined) {
		if (body.color !== null && typeof body.color !== 'string') {
			return apiError(422, 'color must be a hex string');
		}
		patch.color = body.color;
	}

	try {
		const group = await getGroupStore(rt.db).update(id, patch);
		if (!group) return apiError(404, 'group not found');
		await audit(rt, event, 'group.update', `id=${id}`);
		rt.snapshot.invalidate();
		return apiJson({ ok: true, group });
	} catch (err) {
		if (err instanceof GroupError) return apiError(err.status, err.message);
		throw err;
	}
};

export const DELETE: RequestHandler = async (event) => {
	requirePerm(event, 'groups.manage');
	const rt = getRuntime();
	const id = event.params.id;
	if (!(await getGroupStore(rt.db).remove(id))) return apiError(404, 'group not found');
	await audit(rt, event, 'group.delete', `id=${id}`);
	rt.snapshot.invalidate();
	return apiJson({ ok: true });
};
