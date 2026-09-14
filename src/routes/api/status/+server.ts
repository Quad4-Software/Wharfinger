import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';

export const GET: RequestHandler = ({ request }) => {
	const { snapshot, config } = getRuntime();
	const { json, etag } = snapshot.current();

	if (request.headers.get('if-none-match') === etag) {
		return new Response(null, { status: 304, headers: headers(etag, config) });
	}
	return new Response(json, { headers: headers(etag, config) });
};

function headers(etag: string, config: ReturnType<typeof getRuntime>['config']): Headers {
	const h = new Headers({
		'content-type': 'application/json; charset=utf-8',
		etag,
		// Short freshness; SSE pushes real-time changes on top of this.
		'cache-control': `public, max-age=${Math.min(config.page.refresh_seconds, 30)}, stale-while-revalidate=30`
	});
	return h;
}
