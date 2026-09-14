import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, requirePerm } from '$lib/server/admin/http';

/** Trace detail: transaction row plus ordered waterfall spans. */
export const GET: RequestHandler = (event) => {
	requirePerm(event, 'telemetry.view');
	const projectId = Number(event.params.project);
	const traceId = event.params.trace;
	if (!Number.isInteger(projectId) || projectId <= 0 || !/^[a-f0-9]{32}$/i.test(traceId)) {
		return apiError(404, 'unknown trace');
	}
	const r = getRuntime().telemetry.trace(projectId, traceId.toLowerCase());
	if (!r) return apiError(404, 'unknown trace');
	return apiJson(r);
};
