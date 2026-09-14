import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getRuntime } from '$lib/server/runtime';
import { apiKeyOrResponse } from '$lib/server/apikey';

// Deployment markers from CI/automation: write-scoped keys only.
// Mirrors the panel route at /admin/api/markers.
export const GET: RequestHandler = (event) => {
	const rt = getRuntime();
	const auth = apiKeyOrResponse(rt, event.request, 'read');
	if ('res' in auth) return auth.res;
	const limit = Math.min(Number(event.url.searchParams.get('limit') ?? 50) || 50, 200);
	return json(rt.markers.list({ limit }));
};

export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const auth = apiKeyOrResponse(rt, event.request, 'write');
	if ('res' in auth) return auth.res;
	let body: { title?: unknown; kind?: unknown; source?: unknown; service?: unknown; ts?: unknown };
	try {
		body = (await event.request.json()) as typeof body;
	} catch {
		return json({ error: 'invalid json' }, { status: 422 });
	}
	const title = typeof body.title === 'string' ? body.title.trim().slice(0, 256) : '';
	if (!title) return json({ error: 'title is required' }, { status: 422 });
	const kind =
		body.kind === 'deploy' || body.kind === 'release' || body.kind === 'config'
			? body.kind
			: 'note';
	const service = typeof body.service === 'string' ? body.service.slice(0, 128) : '';
	if (service && !rt.config.services.some((s) => s.id === service)) {
		return json({ error: 'unknown service id' }, { status: 422 });
	}
	const ts =
		typeof body.ts === 'number' && Number.isFinite(body.ts) ? Math.round(body.ts) : undefined;
	const marker = rt.markers.add({
		title,
		kind,
		source:
			(typeof body.source === 'string' ? body.source.slice(0, 128) : '') || `api:${auth.key.name}`,
		service: service || null,
		ts
	});
	return json(marker, { status: 201 });
};
