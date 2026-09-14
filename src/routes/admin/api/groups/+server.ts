import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { getGroupStore, GroupError } from '$lib/server/groups/store';

export const GET: RequestHandler = (event) => {
	requirePerm(event, 'groups.manage');
	const rt = getRuntime();
	return apiJson({ groups: getGroupStore(rt.db).list() });
};

interface CreateBody {
	name?: unknown;
	color?: unknown;
}

export const POST: RequestHandler = async (event) => {
	requirePerm(event, 'groups.manage');
	const rt = getRuntime();
	const body = await readJson<CreateBody>(event.request, 8192);
	if (body.color != null && typeof body.color !== 'string') {
		return apiError(422, 'color must be a hex string');
	}
	// null clears the color; format is validated by the store.
	const color = typeof body.color === 'string' ? body.color : null;
	try {
		const group = getGroupStore(rt.db).create(
			typeof body.name === 'string' ? body.name : '',
			color
		);
		audit(rt, event, 'group.create', `id=${group.id} name=${group.name}`);
		rt.snapshot.invalidate();
		return apiJson({ ok: true, group }, 201);
	} catch (err) {
		if (err instanceof GroupError) return apiError(err.status, err.message);
		throw err;
	}
};
