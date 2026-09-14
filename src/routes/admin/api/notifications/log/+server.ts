import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiJson, requirePerm } from '$lib/server/admin/http';

export const GET: RequestHandler = (event) => {
	const rt = getRuntime();
	requirePerm(event, 'status.view');
	return apiJson({ entries: rt.notifyLog.recent(100) });
};
