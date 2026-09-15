import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { getTeamStore, TeamError } from '$lib/server/teams/store';

const MAX_OPS = 200;

function parseIds(v: unknown): number[] | null {
	if (!Array.isArray(v) || v.length > MAX_OPS) return null;
	if (!v.every((e) => Number.isInteger(e))) return null;
	return v as number[];
}

interface PutBody {
	add?: unknown;
	remove?: unknown;
}

export const PUT: RequestHandler = async (event) => {
	requirePerm(event, 'teams.manage');
	const rt = getRuntime();
	const id = event.params.id;
	const body = await readJson<PutBody>(event.request, 32 * 1024);
	const add = parseIds(body.add ?? []);
	const remove = parseIds(body.remove ?? []);
	if (add === null || remove === null) {
		return apiError(422, 'add and remove must be arrays of user ids');
	}
	try {
		const team = await getTeamStore(rt.db).setMembers(id, add, remove);
		await audit(rt, event, 'team.members', `id=${id} +${add.length} -${remove.length}`);
		return apiJson({ ok: true, team });
	} catch (err) {
		if (err instanceof TeamError) return apiError(err.status, err.message);
		throw err;
	}
};
