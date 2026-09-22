import type { RequestHandler } from './$types';
import { isHttpError, json } from '@sveltejs/kit';
import { getRuntime } from '$lib/server/runtime';
import { readJson } from '$lib/server/admin/http';
import { blockedHost } from '$lib/server/http/egress';
import { vapidKeys } from '$lib/server/notify/webpush';
import { SESSION_COOKIE } from '$lib/server/constants';

// Browser Web Push subscription registry. The endpoint is the
// credential the push service issued; knowing it lets the caller
// replace or remove the row, which is safe because possession of the
// endpoint is what authorizes pushes in the first place. When the
// caller carries a valid admin session cookie the row binds to that
// user so the panel can list and revoke it.

const B64URL = /^[A-Za-z0-9_-]+$/;

function decodeLen(s: string): number {
	try {
		return Buffer.from(s, 'base64url').length;
	} catch {
		return -1;
	}
}

function validKeys(body: { keys?: unknown }): { p256dh: string; auth: string } | null {
	const keys = body.keys;
	if (keys === null || typeof keys !== 'object') return null;
	const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
	if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
	// p256dh is the uncompressed P-256 point (65 bytes); auth is the
	// RFC 8291 authentication secret (normally 16 bytes, bounded here).
	if (!B64URL.test(p256dh) || !B64URL.test(auth)) return null;
	if (decodeLen(p256dh) !== 65) return null;
	const authLen = decodeLen(auth);
	if (authLen < 8 || authLen > 128) return null;
	return { p256dh, auth };
}

async function parseBody(request: Request): Promise<{
	endpoint: string;
	keys: { p256dh: string; auth: string };
	userAgent: string | null;
} | null> {
	const body = await readJson<{ endpoint?: unknown; keys?: unknown; userAgent?: unknown }>(
		request,
		8192
	);
	const raw = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
	if (!raw || raw.length > 2048) return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	// Push services are always https; the egress check below refuses
	// link-local and metadata hosts anyway.
	if (url.protocol !== 'https:' || blockedHost(url.hostname)) return null;
	const keys = validKeys(body);
	if (!keys) return null;
	const userAgent =
		typeof body.userAgent === 'string' && body.userAgent.length <= 300 ? body.userAgent : null;
	return { endpoint: url.toString(), keys, userAgent };
}

export const GET: RequestHandler = () => {
	const rt = getRuntime();
	return json({
		vapidPublicKey: vapidKeys().publicKey,
		enabled: rt.config.notifications.enabled
	});
};

export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	let parsed: Awaited<ReturnType<typeof parseBody>>;
	try {
		parsed = await parseBody(event.request);
	} catch (err) {
		if (isHttpError(err)) return json({ error: err.body.message }, { status: err.status });
		return json({ error: 'invalid json' }, { status: 422 });
	}
	if (!parsed) return json({ error: 'invalid subscription' }, { status: 422 });

	// The session cookie only resolves under the admin mount in hooks,
	// so bind user_id by resolving it here directly.
	let userId: number | null = null;
	const token = event.cookies.get(SESSION_COOKIE);
	if (token) {
		const resolved = await rt.sessions.resolve(token, rt.sessionTtlMs());
		userId = resolved?.user.id ?? null;
	}

	const userAgent =
		parsed.userAgent ?? event.request.headers.get('user-agent')?.slice(0, 300) ?? null;
	const sub = await rt.pushSubs.add({
		endpoint: parsed.endpoint,
		p256dh: parsed.keys.p256dh,
		auth: parsed.keys.auth,
		userId,
		userAgent
	});
	if (!sub) return json({ error: 'subscription limit reached' }, { status: 429 });
	return json({ ok: true, vapidPublicKey: vapidKeys().publicKey });
};

export const DELETE: RequestHandler = async (event) => {
	const rt = getRuntime();
	let body: { endpoint?: unknown };
	try {
		body = await readJson(event.request, 8192);
	} catch (err) {
		if (isHttpError(err)) return json({ error: err.body.message }, { status: err.status });
		return json({ error: 'invalid json' }, { status: 422 });
	}
	const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
	if (!endpoint || endpoint.length > 2048) {
		return json({ error: 'endpoint is required' }, { status: 422 });
	}
	await rt.pushSubs.remove(endpoint);
	return json({ ok: true });
};
