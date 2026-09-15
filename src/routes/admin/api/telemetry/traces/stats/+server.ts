import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, requirePerm } from '$lib/server/admin/http';

/** Per-transaction-name latency stats: ?project=N */
export const GET: RequestHandler = async (event) => {
	requirePerm(event, 'telemetry.view');
	const project = Number(event.url.searchParams.get('project'));
	if (!Number.isInteger(project) || project <= 0) return apiError(422, 'project required');
	return apiJson({ stats: await getRuntime().telemetry.transactionStats(project) });
};
