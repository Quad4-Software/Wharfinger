import { createHash, randomBytes } from 'node:crypto';
import type { StatusConfig } from '../config/schema';
import type { Role } from '$lib/shared/auth';
import { blockedHost, type Egress } from '$lib/server/http/egress';
import { roleFromGroups } from './external';

// OIDC authorization-code flow with PKCE. Tested against Pocket ID;
// works with any spec-compliant provider that exposes discovery and a
// userinfo endpoint. Claims are read from userinfo (not a decoded JWT)
// so no JWKS handling is needed here.

interface OidcMeta {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	userinfo_endpoint: string;
}

const metaCache = new Map<string, { meta: OidcMeta; at: number }>();
const META_TTL_MS = 3600_000;

type OidcCfg = StatusConfig['oidc'];

export function oidcReady(cfg: OidcCfg): boolean {
	return cfg.enabled && cfg.client_id.length > 0;
}

export function newPkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	return { verifier, challenge };
}

export function newState(): string {
	return randomBytes(16).toString('base64url');
}

// The issuer is operator-configured, which means anyone with
// admin.settings (or a compromised file) can point discovery at
// internal infrastructure. Every provider fetch goes through the
// shared egress dispatcher so DNS is re-validated at connect time and
// link-local/metadata targets are refused.
function guardedOidcFetch(egress: Egress | null, url: string, init?: RequestInit) {
	if (egress && !egress.allowLinkLocal()) {
		let host: string;
		try {
			host = new URL(url).hostname;
		} catch {
			throw new Error('oidc endpoint url is not parseable');
		}
		if (blockedHost(host)) throw new Error('oidc endpoint is blocked by egress policy');
	}
	return fetch(url, {
		...init,
		signal: AbortSignal.timeout(10_000),
		...(egress ? { dispatcher: egress.dispatcher } : {})
	});
}

async function discover(issuer: string, egress: Egress | null): Promise<OidcMeta> {
	const hit = metaCache.get(issuer);
	if (hit && Date.now() - hit.at < META_TTL_MS) return hit.meta;
	const res = await guardedOidcFetch(egress, `${issuer}/.well-known/openid-configuration`);
	if (!res.ok) throw new Error(`oidc discovery failed (${res.status})`);
	const doc = (await res.json()) as Partial<OidcMeta>;
	if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.userinfo_endpoint) {
		throw new Error('oidc discovery document is missing endpoints');
	}
	const meta: OidcMeta = {
		issuer: doc.issuer ?? issuer,
		authorization_endpoint: doc.authorization_endpoint,
		token_endpoint: doc.token_endpoint,
		userinfo_endpoint: doc.userinfo_endpoint
	};
	metaCache.set(issuer, { meta, at: Date.now() });
	return meta;
}

export async function authorizeUrl(
	cfg: OidcCfg,
	redirectUri: string,
	state: string,
	challenge: string,
	egress: Egress | null = null
): Promise<string> {
	const meta = await discover(cfg.issuer, egress);
	const url = new URL(meta.authorization_endpoint);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', cfg.client_id);
	url.searchParams.set('redirect_uri', redirectUri);
	url.searchParams.set('scope', cfg.scopes);
	url.searchParams.set('state', state);
	url.searchParams.set('code_challenge', challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	return url.toString();
}

interface TokenResponse {
	access_token?: string;
	error?: string;
	error_description?: string;
}

export async function exchangeCode(
	cfg: OidcCfg,
	redirectUri: string,
	code: string,
	verifier: string,
	egress: Egress | null = null
): Promise<string> {
	const meta = await discover(cfg.issuer, egress);
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		client_id: cfg.client_id,
		redirect_uri: redirectUri,
		code,
		code_verifier: verifier
	});
	if (cfg.client_secret) body.set('client_secret', cfg.client_secret);
	const res = await guardedOidcFetch(egress, meta.token_endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body
	});
	const data = (await res.json().catch(() => ({}))) as TokenResponse;
	if (!res.ok || !data.access_token) {
		throw new Error(`token exchange failed: ${data.error ?? res.status}`);
	}
	return data.access_token;
}

export async function userinfo(
	cfg: OidcCfg,
	accessToken: string,
	egress: Egress | null = null
): Promise<Record<string, unknown>> {
	const meta = await discover(cfg.issuer, egress);
	const res = await guardedOidcFetch(egress, meta.userinfo_endpoint, {
		headers: { authorization: `Bearer ${accessToken}` }
	});
	if (!res.ok) throw new Error(`userinfo failed (${res.status})`);
	return (await res.json()) as Record<string, unknown>;
}

export interface OidcIdentity {
	externalId: string;
	username: string;
	displayName: string;
	role: Role;
}

/**
 * Map userinfo claims to a local identity. Returns null when the
 * subject has no usable role (deny policy).
 */
export function mapClaims(cfg: OidcCfg, claims: Record<string, unknown>): OidcIdentity | null {
	const sub = typeof claims.sub === 'string' ? claims.sub : null;
	if (!sub) return null;
	const rawGroups = claims[cfg.groups_claim];
	const groups = Array.isArray(rawGroups)
		? rawGroups.filter((g): g is string => typeof g === 'string')
		: [];
	const role = roleFromGroups(groups, cfg);
	if (!role) return null;
	const uname =
		typeof claims[cfg.username_claim] === 'string'
			? (claims[cfg.username_claim] as string)
			: typeof claims.preferred_username === 'string'
				? claims.preferred_username
				: typeof claims.email === 'string'
					? claims.email.split('@')[0]
					: sub;
	const displayName = typeof claims.name === 'string' && claims.name ? claims.name : uname;
	return {
		// Issuer pins the external id so a different provider cannot
		// replay the same sub against this account.
		externalId: `${cfg.issuer}|${sub}`,
		username: uname.slice(0, 64),
		displayName: displayName.slice(0, 128),
		role
	};
}
