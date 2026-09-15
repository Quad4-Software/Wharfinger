import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, requirePerm } from '$lib/server/admin/http';
import { forgeKind, listBranches, parseRepoCoords } from '$lib/server/deploy/forge';

/**
 * Repo browse: branch names for the app's git source, through the
 * egress guard. Uses the stored forge token when one exists so
 * private repos list too; public repos answer unauthenticated.
 * Generic forges have no list API and return 422.
 */
export const GET: RequestHandler = async (event) => {
	requirePerm(event, 'deploy.view');
	const rt = getRuntime();
	const app = await rt.deploys.getApp(event.params.id);
	if (!app) return apiError(404, 'app not found');
	if (app.source.kind !== 'git' || !app.source.url) {
		return apiError(422, 'branches are only listed for git sources');
	}
	const coords = parseRepoCoords(app.source.url);
	if (!coords) return apiError(422, 'repo url is not API-addressable');
	const kind = forgeKind(app.source.forge, coords);
	const token = await rt.deploys.forgeToken(app.id);
	const res = await listBranches(rt.egress, kind, coords, token);
	if (!res.ok) return apiError(422, res.error ?? 'branch listing failed');
	return apiJson({ branches: res.branches });
};
