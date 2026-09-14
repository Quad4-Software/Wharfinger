import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, requirePerm } from '$lib/server/admin/http';

/** Paginated trace list: ?project=N&page=&q=&name= */
export const GET: RequestHandler = (event) => {
	requirePerm(event, 'telemetry.view');
	const rt = getRuntime();
	const sp = event.url.searchParams;
	const project = Number(sp.get('project'));
	if (!Number.isInteger(project) || project <= 0) return apiError(422, 'project required');
	const page = Math.max(1, Number(sp.get('page') ?? 1) || 1);
	const q = (sp.get('q') ?? '').slice(0, 200);
	const name = (sp.get('name') ?? '').slice(0, 256);
	const r = rt.telemetry.traces(project, {
		limit: 50,
		offset: (page - 1) * 50,
		q: q || undefined,
		name: name || undefined
	});
	return apiJson({ traces: r.entries, total: r.total, page, pageSize: 50 });
};
