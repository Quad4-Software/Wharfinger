import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiJson, requirePerm } from '$lib/server/admin/http';
import { AUDIT_PAGE_SIZE } from '$lib/server/constants';

const EXPORT_MAX = 50_000;

function csvCell(v: string | number | null): string {
	let s = v === null ? '' : String(v);
	// A leading formula trigger executes when the csv is opened in a
	// spreadsheet; audit detail carries user-controlled strings.
	if (/^[=+\-@]/.test(s)) s = `'${s}`;
	return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export const GET: RequestHandler = (event) => {
	const rt = getRuntime();
	requirePerm(event, 'audit.view');
	const page = Math.max(1, Number(event.url.searchParams.get('page') ?? 1));
	const action = event.url.searchParams.get('action') ?? undefined;
	const q = event.url.searchParams.get('q')?.slice(0, 200) ?? undefined;
	const user = event.url.searchParams.get('user')?.slice(0, 100) ?? undefined;

	if (event.url.searchParams.get('format') === 'csv') {
		const rows = rt.audit.exportRows({ action, q, user, max: EXPORT_MAX });
		const body = [
			'at,username,action,detail,ip',
			...rows.map((r) =>
				[
					new Date(r.at).toISOString(),
					csvCell(r.username),
					csvCell(r.action),
					csvCell(r.detail),
					csvCell(r.ip)
				].join(',')
			)
		].join('\n');
		return new Response(body + '\n', {
			headers: {
				'content-type': 'text/csv; charset=utf-8',
				'content-disposition': `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`
			}
		});
	}

	const { entries, total } = rt.audit.list({
		limit: AUDIT_PAGE_SIZE,
		offset: (page - 1) * AUDIT_PAGE_SIZE,
		action,
		q,
		user
	});
	return apiJson({
		entries,
		total,
		page,
		pageSize: AUDIT_PAGE_SIZE,
		actions: rt.audit.actions(),
		summary: rt.audit.summary({ action, q, user })
	});
};
