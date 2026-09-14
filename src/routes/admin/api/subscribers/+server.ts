import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, requirePerm } from '$lib/server/admin/http';

export const GET: RequestHandler = (event) => {
	const rt = getRuntime();
	requirePerm(event, 'status.view');
	return apiJson({
		subscribers: rt.subscribers.list().map((s) => ({
			id: s.id,
			url: s.url,
			services: s.services,
			confirmed: s.confirmedAt !== null,
			createdAt: s.createdAt,
			disabled: s.disabledAt !== null
		}))
	});
};

export const DELETE: RequestHandler = (event) => {
	const rt = getRuntime();
	requirePerm(event, 'status.manage');
	const id = Number(event.url.searchParams.get('id'));
	if (!Number.isInteger(id) || id <= 0) return apiError(422, 'id is required');
	if (!rt.subscribers.remove(id)) return apiError(404, 'subscriber not found');
	audit(rt, event, 'subscribers.delete', `subscriber ${id}`);
	return apiJson({ ok: true });
};
