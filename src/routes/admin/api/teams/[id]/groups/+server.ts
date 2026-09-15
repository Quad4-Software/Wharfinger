import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { getTeamStore, TeamError } from '$lib/server/teams/store';

interface PutBody {
	groupIds?: unknown;
}

export const PUT: RequestHandler = async (event) => {
	requirePerm(event, 'teams.manage');
	const rt = getRuntime();
	const id = event.params.id;
	const body = await readJson<PutBody>(event.request, 32 * 1024);
	const groupIds = body.groupIds;
	if (
		!Array.isArray(groupIds) ||
		groupIds.length > 100 ||
		!groupIds.every((g) => typeof g === 'string')
	) {
		return apiError(422, 'groupIds must be an array of group id strings');
	}
	try {
		const team = await getTeamStore(rt.db).setGroups(id, groupIds);
		await audit(rt, event, 'team.groups', `id=${id} groups=${groupIds.length}`);
		return apiJson({ ok: true, team });
	} catch (err) {
		if (err instanceof TeamError) return apiError(err.status, err.message);
		throw err;
	}
};
