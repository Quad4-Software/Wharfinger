import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';

// One-shot confirmation link delivered to the webhook endpoint.
export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	const token = event.url.searchParams.get('token') ?? '';
	const ok = /^[0-9a-f]{48}$/.test(token) && (await rt.subscribers.confirm(token));
	return new Response(
		ok
			? '<!doctype html><title>Subscribed</title><p>Subscription confirmed. You will now receive status webhooks.</p>'
			: '<!doctype html><title>Invalid</title><p>Invalid or already-used confirmation link.</p>',
		{ status: ok ? 200 : 404, headers: { 'content-type': 'text/html' } }
	);
};
