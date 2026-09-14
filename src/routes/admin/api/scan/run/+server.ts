import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { DeployError } from '$lib/server/deploy/store';
import { enqueueScan } from '$lib/server/scan/trigger';
import { getScanStore } from '$lib/server/scan/store';

/** Queue a trivy scan of the app's current (or a given) image. */
export const POST: RequestHandler = async (event) => {
	requirePerm(event, 'scan.manage');
	const rt = getRuntime();
	const body = await readJson<{ appId?: unknown; releaseId?: unknown }>(event.request, 8192);
	const appId = typeof body.appId === 'string' ? body.appId : '';
	if (!appId) return apiError(422, 'appId is required');
	try {
		const { job, report, deduped } = enqueueScan(rt.deploys, rt.jobs, getScanStore(rt.db), appId, {
			releaseId: typeof body.releaseId === 'string' ? body.releaseId : undefined
		});
		if (!deduped) {
			audit(
				rt,
				event,
				'scan.run',
				`app=${appId} scan=${report.id} target=${report.target} job=${job?.id}`
			);
		}
		return apiJson({ ok: true, jobId: job?.id ?? null, report, deduped }, deduped ? 200 : 201);
	} catch (err) {
		if (err instanceof DeployError) return apiError(err.status, err.message);
		throw err;
	}
};
