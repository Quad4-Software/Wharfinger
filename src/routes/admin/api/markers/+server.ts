import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, asString, audit, readJson, requirePerm } from '$lib/server/admin/http';

// Deployment markers: manual POSTs (CI, release scripts) plus the
// automation API. Shown on charts and the dashboard timeline.

export const GET: RequestHandler = (event) => {
	const rt = getRuntime();
	requirePerm(event, 'status.view');
	const url = event.url;
	const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
	const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);
	return apiJson(rt.markers.list({ limit, offset }));
};

export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requirePerm(event, 'status.manage');
	const body = await readJson<{
		title?: unknown;
		kind?: unknown;
		source?: unknown;
		service?: unknown;
		ts?: unknown;
	}>(event.request, 16 * 1024);

	const title = asString(body.title, 256);
	if (!title) return apiError(422, 'title is required');
	const kind =
		body.kind === 'deploy' || body.kind === 'release' || body.kind === 'config'
			? body.kind
			: 'note';
	const service = asString(body.service, 128);
	if (service && !rt.config.services.some((s) => s.id === service)) {
		return apiError(422, 'unknown service id');
	}
	const ts =
		typeof body.ts === 'number' && Number.isFinite(body.ts) ? Math.round(body.ts) : undefined;
	const marker = rt.markers.add({
		title,
		kind,
		source: asString(body.source, 128) ?? user.username,
		service,
		ts
	});
	audit(rt, event, 'markers.create', `${title} (${kind})`);
	return apiJson(marker, 201);
};

export const DELETE: RequestHandler = (event) => {
	const rt = getRuntime();
	requirePerm(event, 'status.manage');
	const id = Number(event.url.searchParams.get('id'));
	if (!Number.isInteger(id) || id <= 0) return apiError(422, 'id is required');
	if (!rt.markers.remove(id)) return apiError(404, 'marker not found');
	audit(rt, event, 'markers.delete', `marker ${id}`);
	return apiJson({ ok: true });
};
