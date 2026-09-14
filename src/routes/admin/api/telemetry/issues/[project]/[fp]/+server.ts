import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';

function ids(event: Parameters<RequestHandler>[0]): { projectId: number; fp: string } | null {
	const projectId = Number(event.params.project);
	const fp = event.params.fp;
	if (!Number.isInteger(projectId) || projectId <= 0 || !/^[a-f0-9]{16,64}$/i.test(fp)) {
		return null;
	}
	return { projectId, fp };
}

/** Issue detail plus a page of its events. */
export const GET: RequestHandler = (event) => {
	requirePerm(event, 'telemetry.view');
	const rt = getRuntime();
	const k = ids(event);
	if (!k) return apiError(404, 'unknown issue');
	const issue = rt.telemetry.issue(k.projectId, k.fp);
	if (!issue) return apiError(404, 'unknown issue');
	const page = Math.max(1, Number(event.url.searchParams.get('page') ?? 1) || 1);
	const r = rt.telemetry.events(k.projectId, k.fp, { limit: 20, offset: (page - 1) * 20 });
	return apiJson({ issue, events: r.entries, total: r.total, page, pageSize: 20 });
};

/** Resolve or reopen an issue. */
export const PATCH: RequestHandler = async (event) => {
	requirePerm(event, 'telemetry.manage');
	const rt = getRuntime();
	const k = ids(event);
	if (!k || !rt.telemetry.issue(k.projectId, k.fp)) return apiError(404, 'unknown issue');
	const body = await readJson<{ resolved?: unknown }>(event.request, 2048);
	rt.telemetry.setIssueResolved(k.projectId, k.fp, body.resolved === true);
	audit(rt, event, 'telemetry.issue.resolve', body.resolved === true ? 'resolved' : 'reopened');
	return apiJson({ ok: true });
};
