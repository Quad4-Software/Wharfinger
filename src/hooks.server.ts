import type { Handle, HandleServerError, RequestEvent, Reroute, ServerInit } from '@sveltejs/kit';
import { isHttpError } from '@sveltejs/kit';
import { getRuntime } from '$lib/server/runtime';
import { isChatBridge } from '$lib/server/admin/chat';
import { captureException, scrubUrl } from '$lib/server/telemetry';
import { SESSION_COOKIE } from '$lib/server/constants';
import {
	PUBLIC_API_PREFIX,
	PUBLIC_BADGE_PREFIX,
	PUBLIC_FAVICON_PREFIX,
	paths
} from '$lib/shared/paths';

export const init: ServerInit = () => {
	getRuntime();
};

// style-src needs unsafe-inline for the per-service accent style
// attributes; everything else stays same-origin only.
function securityHeaders(): Record<string, string> {
	// site.frame_ancestors controls who may iframe the page. Default
	// 'self' keeps the admin preview working; extra origins opt in
	// embedding for homepage dashboards and the like. '*' is rejected
	// by the config schema.
	let ancestors = ["'self'"];
	try {
		const configured = getRuntime().config.site.frame_ancestors;
		if (configured.length) ancestors = configured;
	} catch {
		// Runtime not ready (build-time prerender); keep the default.
	}
	const selfOnly = ancestors.every((a) => a === "'self'");
	const headers: Record<string, string> = {
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'strict-origin-when-cross-origin',
		'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
		'content-security-policy': [
			"default-src 'self'",
			"img-src 'self' data: blob:",
			"style-src 'self' 'unsafe-inline'",
			"font-src 'self'",
			"script-src 'self'",
			"connect-src 'self'",
			"object-src 'none'",
			"base-uri 'none'",
			"form-action 'self'",
			`frame-ancestors ${ancestors.join(' ')}`
		].join('; '),
		// The badge, favicon, and API endpoints are meant to be embedded
		// and fetched cross-origin; they relax CORP per-route below.
		'cross-origin-resource-policy': 'same-origin'
	};
	// X-Frame-Options cannot express an origin list: SAMEORIGIN only
	// when the config is self-only, omitted once external ancestors
	// are allowed (CSP frame-ancestors covers every modern browser).
	if (selfOnly) headers['x-frame-options'] = 'SAMEORIGIN';
	return headers;
}

// Everything under the admin mount is noindexed and uncacheable, both
// for confidentiality and so invite/setup links are never indexed.
const ADMIN_HEADERS: Record<string, string> = {
	'x-robots-tag': 'noindex, nofollow, noarchive',
	'cache-control': 'no-store'
};

// Forwarded headers are only trusted when the deployment opts in via
// WHARFINGER_TRUST_PROXY (set when a reverse proxy overwrites them). A
// directly exposed app must use the socket address: client-supplied
// XFF would let anyone rotate the rate-limit key per request and
// bypass brute-force and flood limits entirely.
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.WHARFINGER_TRUST_PROXY ?? '');

function clientKey(event: RequestEvent): string {
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

function adminBasePath(): string {
	try {
		return getRuntime().adminBase();
	} catch {
		return '/admin';
	}
}

/**
 * Cross-site mutation guard for the cookie-authenticated admin mount.
 * SameSite=Lax already blocks cross-site posts, but a compromised
 * sibling origin still sends the session cookie; comparing Origin to
 * the request origin closes that. Sec-Fetch-Site cross-site is
 * rejected even when Origin is absent.
 */
function crossOriginMutation(event: RequestEvent): boolean {
	const m = event.request.method;
	if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;
	if (event.request.headers.get('sec-fetch-site') === 'cross-site') return true;
	const origin = event.request.headers.get('origin');
	if (!origin) return false;
	try {
		return new URL(origin).origin !== event.url.origin;
	} catch {
		return true;
	}
}

/** Socket-peer loopback check, independent of any forwarded header. */
function isLoopbackPeer(event: RequestEvent): boolean {
	try {
		const a = event.getClientAddress();
		return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
	} catch {
		return false;
	}
}

// isChatBridge (loopback socket peer plus the per-process token from
// server/bootstrap-env.mjs) lives in admin/chat.ts so the routes and
// this gate share one implementation.

/**
 * Route translation for the movable admin mount. When admin.base_path
 * is '/console', a request to /console/users matches the /admin/users
 * route while event.url keeps the external path. The literal /admin
 * tree is hidden by the 404 in handle below.
 */
export const reroute: Reroute = ({ url }) => {
	const base = adminBasePath();
	if (base === '/admin') return undefined;
	if (url.pathname === base || url.pathname.startsWith(`${base}/`)) {
		return `/admin${url.pathname.slice(base.length)}`;
	}
	return undefined;
};

// Admin paths reachable without a session. Everything else under the
// mount requires an authenticated user.
const PUBLIC_ADMIN_PAGES = ['/login', '/setup'];
const PUBLIC_ADMIN_API = [
	'/api/auth/login',
	'/api/auth/setup',
	'/api/auth/oidc/start',
	'/api/auth/oidc/callback',
	'/api/auth/passkey/options',
	'/api/auth/passkey/verify'
];

function isPublicAdminPath(sub: string): boolean {
	if (PUBLIC_ADMIN_PAGES.includes(sub) || PUBLIC_ADMIN_API.includes(sub)) return true;
	// Invite accept page and its lookup/accept endpoints.
	if (sub.startsWith('/invite/')) return true;
	if (sub.startsWith('/api/invite/')) return true;
	return false;
}

export const handle: Handle = async ({ event, resolve }) => {
	const { pathname } = event.url;
	const rt = getRuntime();
	// Storage backend connect + override merge + bootstrap. With sqlite
	// this resolves immediately; with a remote backend the first request
	// waits for the wire handshake instead of hitting a cold store.
	await rt.ready;
	const base = rt.adminBase();

	event.locals.user = null;
	event.locals.perms = null;
	event.locals.sessionHash = null;
	event.locals.adminBase = base;

	const underAdmin = pathname === base || pathname.startsWith(`${base}/`);
	const underLiteralAdmin = pathname === '/admin' || pathname.startsWith('/admin/');

	if (underLiteralAdmin && base !== '/admin') {
		// Panel moved; do not reveal the internal route tree.
		return new Response('Not found', { status: 404 });
	}

	if (underAdmin) {
		if (!rt.adminEnabled()) return new Response('Not found', { status: 404 });

		const sub = pathname.slice(base.length) || '/';
		const isApi = sub.startsWith('/api/');
		const isAuthApi = PUBLIC_ADMIN_API.includes(sub) || sub.startsWith('/api/invite/');
		// Chat bridge traffic shares one loopback address for every
		// connected user, so it would otherwise exhaust the admin
		// limiter and trip the session gate (sends carry an x-chat-user
		// claim instead of a cookie). Scoped to /api/chat/ only.
		const chatInternal = isApi && sub.startsWith('/api/chat/') && isChatBridge(event);

		// Session resolution, only inside the panel mount.
		const token = event.cookies.get(SESSION_COOKIE);
		if (token) {
			const resolved = await rt.sessions.resolve(token, rt.sessionTtlMs());
			if (resolved) {
				event.locals.user = resolved.user;
				event.locals.perms = await rt.roles.permsFor(resolved.user.role);
				event.locals.sessionHash = resolved.tokenHash;
			}
		}

		// Brute-force and abuse limits: tight on auth endpoints, looser on
		// the authenticated JSON API.
		const key = clientKey(event);
		const limiter = isAuthApi ? rt.authLimiter : rt.adminLimiter;
		if (isApi && !chatInternal && !limiter.allow(key)) {
			return new Response(JSON.stringify({ error: 'rate limit exceeded' }), {
				status: 429,
				headers: { 'content-type': 'application/json', 'retry-after': '60', ...ADMIN_HEADERS }
			});
		}

		if (isApi && crossOriginMutation(event)) {
			return new Response(JSON.stringify({ error: 'cross-origin request rejected' }), {
				status: 403,
				headers: { 'content-type': 'application/json', ...ADMIN_HEADERS }
			});
		}

		if (!event.locals.user && !isPublicAdminPath(sub) && !chatInternal) {
			if (isApi) {
				return new Response(JSON.stringify({ error: 'authentication required' }), {
					status: 401,
					headers: { 'content-type': 'application/json', ...ADMIN_HEADERS }
				});
			}
			const next = encodeURIComponent(pathname + event.url.search);
			return Response.redirect(`${event.url.origin}${base}/login?next=${next}`, 303);
		}
	} else if (pathname === '/ingress' || pathname.startsWith('/ingress/')) {
		// Agent ingest. Same public limiter family as /api; authenticated
		// per-token inside the handlers, IP-limited here so unauthenticated
		// floods cannot reach the db. Loopback peers are exempt: the ws
		// bridge forwards every frame through these routes and all of its
		// traffic shares one address, so an external flood would otherwise
		// exhaust the bucket and knock every ws agent offline.
		if (!isLoopbackPeer(event) && !rt.limiter.allow(clientKey(event))) {
			return new Response(JSON.stringify({ error: 'rate limit exceeded' }), {
				status: 429,
				headers: { 'content-type': 'application/json', 'retry-after': '60' }
			});
		}
	} else if (pathname.startsWith(PUBLIC_API_PREFIX) && pathname !== paths.apiStream) {
		if (!rt.limiter.allow(clientKey(event))) {
			return new Response('rate limit exceeded', {
				status: 429,
				headers: { 'retry-after': '60' }
			});
		}
	}

	const response = await resolve(event);
	for (const [k, v] of Object.entries(securityHeaders())) {
		if (!response.headers.has(k)) response.headers.set(k, v);
	}
	if (underAdmin) {
		for (const [k, v] of Object.entries(ADMIN_HEADERS)) {
			if (!response.headers.has(k)) response.headers.set(k, v);
		}
	} else if (
		pathname.startsWith(PUBLIC_API_PREFIX) ||
		pathname.startsWith(PUBLIC_BADGE_PREFIX) ||
		pathname.startsWith(PUBLIC_FAVICON_PREFIX)
	) {
		// Public, cacheable, embeddable resources. Admin API paths live
		// outside /api/ so they never get the cross-origin treatment.
		response.headers.set('access-control-allow-origin', '*');
		response.headers.set('cross-origin-resource-policy', 'cross-origin');
	}
	return response;
};

/**
 * Unexpected failures get a correlation id, a console line, and a
 * telemetry event. Expected HttpErrors (error() calls, 404s) only get
 * reported at 5xx, so routine misses stay out of the error tracker.
 * The returned errorId surfaces on the error page for bug reports.
 */
export const handleError: HandleServerError = ({ error, event, status, message }) => {
	const errorId = crypto.randomUUID();
	const expected = isHttpError(error) && status < 500;
	if (!expected) {
		console.error(
			`[error] ${status} ${event.request.method} ${event.url.pathname} (${errorId}):`,
			error
		);
		captureException(error, {
			tags: {
				errorId,
				route: event.route.id ?? '',
				status: String(status)
			},
			request: {
				url: scrubUrl(event.url.href),
				method: event.request.method,
				headers: { 'user-agent': event.request.headers.get('user-agent') ?? '' }
			}
		});
	}
	return { message, errorId };
};
