import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { getTeamStore, TeamError } from '$lib/server/teams/store';

export const GET: RequestHandler = (event) => {
	requirePerm(event, 'teams.manage');
	const rt = getRuntime();
	return apiJson({
		teams: getTeamStore(rt.db).list(),
		// Minimal directory for the member picker.
		users: rt.users.all().map((u) => ({
			id: u.id,
			username: u.username,
			displayName: u.displayName,
			hasAvatar: u.hasAvatar ?? false
		}))
	});
};

interface CreateBody {
	name?: unknown;
}

export const POST: RequestHandler = async (event) => {
	requirePerm(event, 'teams.manage');
	const rt = getRuntime();
	const body = await readJson<CreateBody>(event.request, 8192);
	try {
		const team = getTeamStore(rt.db).create(typeof body.name === 'string' ? body.name : '');
		audit(rt, event, 'team.create', `id=${team.id} name=${team.name}`);
		return apiJson({ ok: true, team }, 201);
	} catch (err) {
		if (err instanceof TeamError) return apiError(err.status, err.message);
		throw err;
	}
};
