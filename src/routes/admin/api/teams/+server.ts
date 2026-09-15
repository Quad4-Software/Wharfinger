import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { getTeamStore, TeamError } from '$lib/server/teams/store';

export const GET: RequestHandler = async (event) => {
	requirePerm(event, 'teams.manage');
	const rt = getRuntime();
	return apiJson({
		teams: await getTeamStore(rt.db).list(),
		// Minimal directory for the member picker.
		users: (await rt.users.all()).map((u) => ({
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
		const team = await getTeamStore(rt.db).create(typeof body.name === 'string' ? body.name : '');
		await audit(rt, event, 'team.create', `id=${team.id} name=${team.name}`);
		return apiJson({ ok: true, team }, 201);
	} catch (err) {
		if (err instanceof TeamError) return apiError(err.status, err.message);
		throw err;
	}
};
