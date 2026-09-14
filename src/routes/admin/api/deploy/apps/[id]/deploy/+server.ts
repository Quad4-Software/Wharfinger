import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { DeployError } from '$lib/server/deploy/store';
import { triggerDeploy } from '$lib/server/deploy/trigger';

/** Queue a deploy (or a rollback to a prior release). */
export const POST: RequestHandler = async (event) => {
	requirePerm(event, 'deploy.manage');
	const rt = getRuntime();
	const app = rt.deploys.getApp(event.params.id);
	if (!app) return apiError(404, 'app not found');
	const body = await readJson<{ rollbackTo?: unknown }>(event.request, 8192);
	try {
		const { job, releaseId } = triggerDeploy(rt, app, {
			rollbackTo: typeof body.rollbackTo === 'string' ? body.rollbackTo : undefined
		});
		const action = body.rollbackTo ? 'deploy.rollback' : 'deploy.trigger';
		audit(rt, event, action, `app=${app.id} release=${releaseId} job=${job.id}`);
		return apiJson({ ok: true, jobId: job.id, releaseId });
	} catch (err) {
		if (err instanceof DeployError) return apiError(err.status, err.message);
		throw err;
	}
};
