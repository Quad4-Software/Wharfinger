import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { getTeamStore, TeamError } from '$lib/server/teams/store';

interface PatchBody {
	name?: unknown;
}

export const PATCH: RequestHandler = async (event) => {
	requirePerm(event, 'teams.manage');
	const rt = getRuntime();
	const id = event.params.id;
	const body = await readJson<PatchBody>(event.request, 8192);
	if (typeof body.name !== 'string') return apiError(422, 'name must be a string');
	try {
		const team = await getTeamStore(rt.db).update(id, body.name);
		if (!team) return apiError(404, 'team not found');
		await audit(rt, event, 'team.update', `id=${id}`);
		return apiJson({ ok: true, team });
	} catch (err) {
		if (err instanceof TeamError) return apiError(err.status, err.message);
		throw err;
	}
};

export const DELETE: RequestHandler = async (event) => {
	requirePerm(event, 'teams.manage');
	const rt = getRuntime();
	const id = event.params.id;
	if (!(await getTeamStore(rt.db).remove(id))) return apiError(404, 'team not found');
	await audit(rt, event, 'team.delete', `id=${id}`);
	return apiJson({ ok: true });
};
