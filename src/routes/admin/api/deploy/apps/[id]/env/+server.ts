import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { DeployError } from '$lib/server/deploy/store';

/** Replace the app's sealed env map. Values never come back out. */
export const PUT: RequestHandler = async (event) => {
	requirePerm(event, 'deploy.manage');
	const rt = getRuntime();
	if (!rt.deploys.getApp(event.params.id)) return apiError(404, 'app not found');
	const body = await readJson<{ env?: unknown }>(event.request, 256 * 1024);
	if (!body.env || typeof body.env !== 'object' || Array.isArray(body.env)) {
		return apiError(422, 'expected an env object');
	}
	try {
		rt.deploys.setEnv(event.params.id, body.env as Record<string, string>);
	} catch (err) {
		if (err instanceof DeployError) return apiError(err.status, err.message);
		throw err;
	}
	audit(rt, event, 'deploy.app.env', `app=${event.params.id}`);
	return apiJson({ ok: true });
};
