import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiJson, requirePerm } from '$lib/server/admin/http';

/** Walk the audit hash chain and report the first broken row, if any. */
export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	requirePerm(event, 'admin.settings');
	return apiJson(await rt.audit.verify());
};
