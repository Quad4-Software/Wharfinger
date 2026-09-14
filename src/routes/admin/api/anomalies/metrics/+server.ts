import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiJson, requirePerm } from '$lib/server/admin/http';
import { getEngine } from '$lib/server/anomaly/engine';

// Tracked metric keys plus their EWMA baseline stats; feeds the
// panel's metric filter and the "vs baseline" display.
export const GET: RequestHandler = (event) => {
	requirePerm(event, 'anomaly.view');
	const rt = getRuntime();
	return apiJson({ metrics: getEngine(rt.db).metrics() });
};
