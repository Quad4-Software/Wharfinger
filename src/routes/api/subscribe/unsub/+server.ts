import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';

// Signed unsubscribe link embedded in every dispatch payload.
export const GET: RequestHandler = (event) => {
	const rt = getRuntime();
	const id = Number(event.url.searchParams.get('id'));
	const token = event.url.searchParams.get('token') ?? '';
	const ok =
		Number.isInteger(id) && id > 0 && /^[0-9a-f]{32}$/.test(token)
			? rt.subscribers.unsubscribe(id, token)
			: false;
	return new Response(
		ok
			? '<!doctype html><title>Unsubscribed</title><p>You will no longer receive status webhooks.</p>'
			: '<!doctype html><title>Invalid</title><p>Invalid unsubscribe link.</p>',
		{ status: ok ? 200 : 404, headers: { 'content-type': 'text/html' } }
	);
};
