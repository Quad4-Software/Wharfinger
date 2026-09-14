import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getRuntime } from '$lib/server/runtime';
import { apiKeyOrResponse } from '$lib/server/apikey';

export const GET: RequestHandler = (event) => {
	const rt = getRuntime();
	const auth = apiKeyOrResponse(rt, event.request, 'read');
	if ('res' in auth) return auth.res;
	return json(rt.snapshot.current().snapshot.incidents);
};
