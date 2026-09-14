import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { authorizeUrl, newPkce, newState, oidcReady } from '$lib/server/admin/oidc';
import { isSecureRequest } from '$lib/server/admin/http';
import { OIDC_COOKIE } from '$lib/server/constants';

// Step 1 of the authorization-code flow: stash state + PKCE verifier
// in a short-lived cookie and send the browser to the provider.
export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	const cfg = rt.config.oidc;
	if (!oidcReady(cfg)) return new Response('not found', { status: 404 });

	const base = rt.adminBase();
	const rawNext = event.url.searchParams.get('next') ?? '';
	// Only paths inside the admin mount may be redirect targets.
	const next = rawNext === base || rawNext.startsWith(`${base}/`) ? rawNext : base;
	const redirectUri = `${event.url.origin}${base}/api/auth/oidc/callback`;

	const state = newState();
	const { verifier, challenge } = newPkce();
	event.cookies.set(OIDC_COOKIE, JSON.stringify({ s: state, v: verifier, n: next }), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: isSecureRequest(event),
		maxAge: 600
	});

	try {
		redirect(302, await authorizeUrl(cfg, redirectUri, state, challenge, rt.egress));
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		console.error('[oidc] discovery/authorize failed:', err);
		redirect(303, `${base}/login?error=oidc_unavailable`);
	}
};
