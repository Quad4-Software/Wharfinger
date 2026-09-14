import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';

// Serves the cached favicon for /favicon/<service-id>. Icons are fetched
// server side into the data dir; nothing third party is ever proxied
// live. SVG icons get a script-blocking CSP so a hostile icon cannot
// execute script in this origin even when opened directly.
export const GET: RequestHandler = ({ params }) => {
	const { icons } = getRuntime();
	const id = params.service.replace(/\.(svg|png|ico|webp|jpg|gif|avif)$/, '');
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
		return new Response('unknown service', { status: 404 });
	}
	const icon = icons.get(id);
	if (!icon) return new Response('no icon', { status: 404 });

	return new Response(new Uint8Array(icon.data), {
		headers: {
			'content-type': icon.contentType,
			'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
			'content-security-policy': "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'",
			'x-content-type-options': 'nosniff',
			'access-control-allow-origin': '*',
			'cross-origin-resource-policy': 'cross-origin'
		}
	});
};
