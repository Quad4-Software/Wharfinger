import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiKeyOrResponse } from '$lib/server/apikey';

// Automation API: the same public snapshot /api/status serves,
// behind a read-scoped key for consumers that want auth.
export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	const auth = await apiKeyOrResponse(rt, event.request, 'read');
	if ('res' in auth) return auth.res;
	const cur = await rt.snapshot.current();
	return new Response(cur.json, {
		headers: { 'content-type': 'application/json', etag: cur.etag }
	});
};
