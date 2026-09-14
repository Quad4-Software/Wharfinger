import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, requirePerm } from '$lib/server/admin/http';
import { getScanStore } from '$lib/server/scan/store';

/**
 * Hardening recommendations. With appId, that app's open recs (or
 * every status with ?status=all); without it, all open recs plus the
 * per-app open counts for the fleet view.
 */
export const GET: RequestHandler = (event) => {
	requirePerm(event, 'scan.view');
	const rt = getRuntime();
	const scans = getScanStore(rt.db);
	const appId = event.url.searchParams.get('appId');
	if (!appId) {
		return apiJson({
			recommendations: scans.allOpen(),
			counts: Object.fromEntries(scans.openCounts())
		});
	}
	if (!rt.deploys.getApp(appId)) return apiError(404, 'app not found');
	const all = event.url.searchParams.get('status') === 'all';
	return apiJson({ recommendations: scans.recsForApp(appId, { openOnly: !all }) });
};
