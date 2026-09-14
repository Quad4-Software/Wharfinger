import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiJson, requirePerm } from '$lib/server/admin/http';

/** Paginated issue list: ?project=N&page=&q=&unresolved=1 */
export const GET: RequestHandler = (event) => {
	requirePerm(event, 'telemetry.view');
	const rt = getRuntime();
	const sp = event.url.searchParams;
	const project = sp.get('project');
	const page = Math.max(1, Number(sp.get('page') ?? 1) || 1);
	const q = (sp.get('q') ?? '').slice(0, 200);
	const unresolved = sp.get('unresolved') === '1';
	const r = rt.telemetry.issues(project ? Number(project) || null : null, {
		limit: 50,
		offset: (page - 1) * 50,
		unresolved,
		q: q || undefined
	});
	return apiJson({ issues: r.entries, total: r.total, page, pageSize: 50 });
};
