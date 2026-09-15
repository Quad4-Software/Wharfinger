import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, requirePerm } from '$lib/server/admin/http';
import { getScanStore } from '$lib/server/scan/store';

/**
 * Scan history. With appId it returns that app's reports newest
 * first plus the latest one; without it, the latest report per app
 * for the fleet view.
 */
export const GET: RequestHandler = async (event) => {
	requirePerm(event, 'scan.view');
	const rt = getRuntime();
	const scans = getScanStore(rt.db);
	const appId = event.url.searchParams.get('appId');
	const limit = Number(event.url.searchParams.get('limit') ?? 50);
	if (!appId) {
		return apiJson({ reports: await scans.latestPerApp(Number.isInteger(limit) ? limit : 200) });
	}
	if (!(await rt.deploys.getApp(appId))) return apiError(404, 'app not found');
	return apiJson({
		reports: await scans.listForApp(appId, Number.isInteger(limit) ? limit : 50),
		latest: await scans.latestForApp(appId)
	});
};
