import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiJson, requireUser } from '$lib/server/admin/http';
import { getTeamStore } from '$lib/server/teams/store';

/**
 * The caller's own teams and their assigned groups, so dashboards can
 * scope service visibility per user. Enforcement beyond visibility
 * (write scoping, per-team permissions) is deferred.
 */
export const GET: RequestHandler = (event) => {
	const user = requireUser(event);
	const rt = getRuntime();
	return apiJson({ teams: getTeamStore(rt.db).teamsForUser(user.id) });
};
