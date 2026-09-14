import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, requirePerm } from '$lib/server/admin/http';
import { getScanStore } from '$lib/server/scan/store';
import { MAX_FINDINGS_PER_REPORT } from '$lib/shared/scan';

/** One report with its findings, bounded by the storage cap. */
export const GET: RequestHandler = (event) => {
	requirePerm(event, 'scan.view');
	const rt = getRuntime();
	const scans = getScanStore(rt.db);
	const report = scans.report(event.params.id);
	if (!report) return apiError(404, 'report not found');
	const limit = Number(event.url.searchParams.get('limit') ?? 500);
	return apiJson({
		report,
		findings: scans.findings(
			report.id,
			Number.isInteger(limit) ? Math.min(limit, MAX_FINDINGS_PER_REPORT) : 500
		)
	});
};
