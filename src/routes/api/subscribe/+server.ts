import type { RequestHandler } from './$types';
import { isHttpError, json } from '@sveltejs/kit';
import { getRuntime } from '$lib/server/runtime';
import { readJson } from '$lib/server/admin/http';
import { blockedHost, type FetchInit } from '$lib/server/http/egress';

// Public webhook subscription: POST {url, services?}. The endpoint
// receives a confirm payload containing a one-shot confirm URL; only
// after that GET lands does the subscription go live (double opt-in,
// so we can never be used to spam a webhook someone else owns).

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'POST, OPTIONS',
	'access-control-allow-headers': 'content-type'
};

export const OPTIONS: RequestHandler = () => new Response(null, { status: 204, headers: CORS });

export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	let body: { url?: unknown; services?: unknown };
	try {
		body = await readJson(event.request, 8192);
	} catch (err) {
		if (isHttpError(err)) {
			return json({ error: err.body.message }, { status: err.status, headers: CORS });
		}
		return json({ error: 'invalid json' }, { status: 422, headers: CORS });
	}
	const raw = typeof body.url === 'string' ? body.url.trim() : '';
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return json({ error: 'invalid url' }, { status: 422, headers: CORS });
	}
	if (!['https:', 'http:'].includes(url.protocol) || raw.length > 512) {
		return json({ error: 'url must be http(s)' }, { status: 422, headers: CORS });
	}
	// Same egress policy as notification targets: link-local/metadata
	// endpoints are refused, DNS is re-validated at connect time.
	if (blockedHost(url.hostname)) {
		return json({ error: 'url host is not allowed' }, { status: 422, headers: CORS });
	}
	const validIds = new Set(rt.config.services.map((s) => s.id));
	const services = Array.isArray(body.services)
		? body.services
				.filter((s): s is string => typeof s === 'string')
				.filter((s) => s === 'all' || validIds.has(s))
				.slice(0, 64)
		: ['all'];
	if (services.length === 0) services.push('all');

	const created = rt.subscribers.create(url.toString(), services);
	if (!created) {
		return json({ error: 'subscriber limit reached' }, { status: 429, headers: CORS });
	}
	const confirmUrl = `${event.url.origin}/api/subscribe/confirm?token=${created.confirmToken}`;
	const payload = JSON.stringify({
		type: 'status.subscribe.confirm',
		site: rt.config.site.name,
		confirm_url: confirmUrl
	});
	void fetch(url.toString(), {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-status-signature': rt.subscribers.signature(created.sub, payload)
		},
		body: payload,
		signal: AbortSignal.timeout(8000),
		dispatcher: rt.egress.dispatcher
	} as FetchInit).catch(() => undefined);

	// Always 202: the response must not reveal whether the webhook
	// accepted the confirmation POST.
	return json({ ok: true }, { status: 202, headers: CORS });
};
