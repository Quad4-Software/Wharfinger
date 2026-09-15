import { error, json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import type { Runtime } from '$lib/server/runtime';
import type { Permission } from './authz';
import type { User } from './users';

export function apiJson(data: unknown, status = 200): Response {
	return json(data, { status });
}

export function apiError(status: number, message: string, extra?: Record<string, unknown>) {
	return json({ error: message, ...extra }, { status });
}

/**
 * Bounded body read returning the exact text. The stream is capped
 * while reading, so a chunked body without a trustworthy
 * content-length cannot buffer unbounded memory before the size check
 * runs. Routes that authenticate a signature over the raw body (the
 * agent proof on POST /ingress) need these exact bytes, not a parse.
 */
export async function readText(request: Request, maxBytes = 256 * 1024): Promise<string> {
	const len = Number(request.headers.get('content-length') ?? 0);
	if (len > maxBytes) error(413, 'body too large');

	if (request.body === null) return '';
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				error(413, 'body too large');
			}
			chunks.push(value);
		}
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		error(400, 'could not read body');
	} finally {
		reader.releaseLock();
	}
	return new TextDecoder().decode(concatBytes(chunks, total));
}

/**
 * Bounded JSON body read. The stream is capped while reading, so a
 * chunked body without a trustworthy content-length cannot buffer
 * unbounded memory before the size check runs.
 */
export async function readJson<T = Record<string, unknown>>(
	request: Request,
	maxBytes = 256 * 1024
): Promise<T> {
	const text = await readText(request, maxBytes);
	try {
		return JSON.parse(text) as T;
	} catch {
		error(400, 'expected a JSON body');
	}
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

/**
 * Whether the client connection used HTTPS. Decides the session cookie
 * Secure flag. server.js stamps x-wharfinger-proto from the socket and the
 * proxy's X-Forwarded-Proto, which also drives event.url.protocol via
 * PROTOCOL_HEADER; dev mode falls back to the request URL.
 */
export function isSecureRequest(event: RequestEvent): boolean {
	const proto = event.request.headers.get('x-wharfinger-proto');
	if (proto) return proto === 'https';
	return event.url.protocol === 'https:';
}

export function requireUser(event: RequestEvent): User {
	if (!event.locals.user) error(401, 'authentication required');
	return event.locals.user;
}

/**
 * locals.perms is resolved from the roles table once per request when
 * hooks.server.ts resolves the session; a missing set fails closed so
 * unknown or deleted roles lose all access immediately.
 */
export function requirePerm(event: RequestEvent, perm: Permission): User {
	const user = requireUser(event);
	if (!event.locals.perms?.has(perm)) error(403, 'insufficient permissions');
	return user;
}

// Same proxy trust rule as the rate-limit key: forwarded headers are
// only honored when WHARFINGER_TRUST_PROXY marks the deployment as
// proxied, otherwise the socket address is authoritative so audit
// entries cannot be forged with a client-supplied XFF.
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.WHARFINGER_TRUST_PROXY ?? '');

export function clientIp(event: RequestEvent): string {
	if (TRUST_PROXY) {
		const fwd = event.request.headers.get('x-forwarded-for');
		if (fwd) return fwd.split(',')[0]?.trim() ?? 'unknown';
		const real = event.request.headers.get('x-real-ip');
		if (real) return real;
	}
	try {
		return event.getClientAddress();
	} catch {
		return 'unknown';
	}
}

export async function audit(
	rt: Runtime,
	event: RequestEvent,
	action: string,
	detail?: string | null
): Promise<void> {
	await rt.audit.log({
		userId: event.locals.user?.id ?? null,
		username: event.locals.user?.username ?? null,
		action,
		detail,
		ip: clientIp(event)
	});
}

/** True when the honeypot field was filled (almost certainly a bot). */
export function honeypotTripped(body: Record<string, unknown>): boolean {
	return typeof body.website === 'string' && body.website.length > 0;
}

export function asString(v: unknown, max = 500): string | null {
	return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

/** Copy an unknown value into an array, or [] when it is not one. */
export function asArray(v: unknown): unknown[] {
	return Array.isArray(v) ? [...(v as unknown[])] : [];
}
