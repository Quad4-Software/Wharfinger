import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';

export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	requirePerm(event, 'notifications.test');
	const body = await readJson<{ target?: unknown }>(event.request, 8192);
	const name = typeof body.target === 'string' ? body.target : '';
	if (!name) return apiError(422, 'target is required');
	const result = await rt.dispatcher.sendTest(name);
	void audit(rt, event, 'notifications.test', `target=${name} ok=${String(result.ok)}`);
	if (!result.ok) return apiError(502, result.error ?? 'delivery failed');
	return apiJson({ ok: true });
};
