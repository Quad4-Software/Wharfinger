import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { exchangeCode, mapClaims, oidcReady, userinfo } from '$lib/server/admin/oidc';
import { knownRole, resolveExternalUser } from '$lib/server/admin/external';
import { setSessionCookie } from '$lib/server/admin/sessions';
import { clientIp, isSecureRequest } from '$lib/server/admin/http';
import { OIDC_COOKIE } from '$lib/server/constants';

interface OidcCookie {
	s?: string;
	v?: string;
	n?: string;
}

// Step 2: state check, code exchange, userinfo, JIT provisioning, and
// a normal panel session. Failures bounce back to the login page with
// an opaque error key; details stay in the server log.
export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	const cfg = rt.config.oidc;
	const base = rt.adminBase();
	const back = (key: string) => redirect(303, `${base}/login?error=${key}`);
	if (!oidcReady(cfg)) return new Response('not found', { status: 404 });

	const raw = event.cookies.get(OIDC_COOKIE);
	event.cookies.delete(OIDC_COOKIE, { path: '/' });
	let jar: OidcCookie;
	try {
		jar = raw ? (JSON.parse(raw) as OidcCookie) : {};
	} catch {
		jar = {};
	}
	const state = event.url.searchParams.get('state') ?? '';
	const code = event.url.searchParams.get('code') ?? '';
	if (!jar.s || jar.s !== state || !code || !jar.v) return back('oidc_state');

	const redirectUri = `${event.url.origin}${base}/api/auth/oidc/callback`;
	const ip = clientIp(event);
	try {
		const accessToken = await exchangeCode(cfg, redirectUri, code, jar.v, rt.egress);
		const claims = await userinfo(cfg, accessToken, rt.egress);
		const ident = mapClaims(cfg, claims);
		const role = ident ? knownRole(rt.roles, ident.role) : null;
		if (!ident || !role) {
			rt.audit.log({ username: ident?.username ?? null, action: 'auth.oidc.denied', ip });
			return back('oidc_denied');
		}
		const user = resolveExternalUser(
			rt.users,
			'oidc',
			ident.externalId,
			ident.username,
			ident.displayName,
			role,
			cfg.sync_profile
		);
		if (!user) {
			rt.audit.log({ username: ident.username, action: 'auth.oidc.disabled', ip });
			return back('oidc_disabled');
		}
		const next = jar.n && (jar.n === base || jar.n.startsWith(`${base}/`)) ? jar.n : base;
		const token = rt.sessions.create(
			user.id,
			rt.sessionTtlMs(),
			ip,
			event.request.headers.get('user-agent')
		);
		setSessionCookie(event.cookies, token, rt.sessionTtlMs(), isSecureRequest(event));
		rt.users.touchLogin(user.id);
		rt.audit.log({ userId: user.id, username: user.username, action: 'auth.oidc.login', ip });
		redirect(303, next);
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		console.error('[oidc] callback failed:', err);
		return back('oidc_error');
	}
};
