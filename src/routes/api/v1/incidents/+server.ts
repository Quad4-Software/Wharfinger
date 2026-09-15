import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getRuntime } from '$lib/server/runtime';
import { apiKeyOrResponse } from '$lib/server/apikey';

export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	const auth = await apiKeyOrResponse(rt, event.request, 'read');
	if ('res' in auth) return auth.res;
	return json((await rt.snapshot.current()).snapshot.incidents);
};
