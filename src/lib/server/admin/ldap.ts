import { Client } from 'ldapts';
import type { StatusConfig } from '../config/schema';
import type { Role } from '$lib/shared/auth';
import { blockedHost, blockedIp, type Egress } from '$lib/server/http/egress';
import { roleFromGroups } from './external';

// LDAP password auth via direct bind, with an optional service-account
// search for display name and group (memberOf) resolution.

type LdapCfg = StatusConfig['ldap'];

export interface LdapIdentity {
	dn: string;
	username: string;
	displayName: string;
	role: Role | null;
}

/** Escape a value for insertion into a distinguished name (RFC 4514). */
function escapeDn(v: string): string {
	let out = v.replace(/([\\,+"<>;=])/g, '\\$1').replace(/\0/g, '');
	out = out.replace(/^ /, '\\ ').replace(/ $/, '\\ ').replace(/^#/, '\\#');
	return out;
}

/** Escape a value for insertion into a search filter (RFC 4515). */
function escapeFilter(v: string): string {
	return v
		.replace(/\\/g, '\\5c')
		.replace(/\*/g, '\\2a')
		.replace(/\(/g, '\\28')
		.replace(/\)/g, '\\29')
		.replace(/\0/g, '\\00');
}

function strAttr(v: unknown): string {
	if (typeof v === 'string') return v;
	if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : '';
	if (v instanceof Uint8Array) return new TextDecoder().decode(v);
	return '';
}

function arrAttr(v: unknown): string[] {
	if (typeof v === 'string') return [v];
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
	return [];
}

export function ldapReady(cfg: LdapCfg): boolean {
	return cfg.enabled && cfg.url.length > 0 && cfg.bind_dn.includes('{username}');
}

/**
 * Refuse directory URLs aimed at link-local or metadata targets when
 * the operator has not opted into link-local egress. ldapts resolves
 * internally so a guarded lookup cannot be injected; the precheck
 * still covers literal addresses, metadata hostnames, and DNS
 * answers known at this point.
 */
async function ldapTargetBlocked(egress: Egress, url: string): Promise<boolean> {
	if (egress.allowLinkLocal()) return false;
	let host = '';
	try {
		host = new URL(url).hostname;
	} catch {
		return true;
	}
	if (blockedHost(host)) return true;
	return await new Promise((resolve) => {
		egress.lookup(host, {}, (err, address) => {
			if (err) {
				resolve(err.code === 'EAI_BLOCKED');
				return;
			}
			const ips = Array.isArray(address) ? address.map((a) => a.address) : [address];
			resolve(ips.some((ip) => blockedIp(ip)));
		});
	});
}

/**
 * Authenticate a username/password against the directory. Returns the
 * identity with a resolved role, or null on any failure (bad password,
 * unreachable server, misconfiguration). Errors are intentionally
 * collapsed: callers log a generic failure line.
 */
export async function ldapAuthenticate(
	cfg: LdapCfg,
	username: string,
	password: string,
	egress: Egress | null = null
): Promise<LdapIdentity | null> {
	if (!ldapReady(cfg) || !password) return null;
	if (egress && (await ldapTargetBlocked(egress, cfg.url))) return null;
	const dn = cfg.bind_dn.replaceAll('{username}', escapeDn(username));
	const client = new Client({
		url: cfg.url,
		timeout: cfg.timeout_ms,
		connectTimeout: cfg.timeout_ms
	});
	try {
		if (cfg.starttls) await client.startTLS();
		await client.bind(dn, password);

		let displayName = username;
		let groups: string[] = [];
		if (cfg.search_base) {
			if (cfg.search_bind_dn) {
				await client.bind(cfg.search_bind_dn, cfg.search_bind_password);
			}
			const filter = cfg.user_filter.replaceAll('{username}', escapeFilter(username));
			const { searchEntries } = await client.search(cfg.search_base, {
				scope: 'sub',
				filter,
				attributes: [cfg.display_attr, 'memberOf'],
				sizeLimit: 5
			});
			if (searchEntries.length > 0) {
				const entry = searchEntries[0];
				displayName = strAttr(entry[cfg.display_attr]) || username;
				groups = arrAttr(entry.memberOf);
			}
		}
		return {
			dn,
			username,
			displayName: displayName.slice(0, 128),
			role: roleFromGroups(groups, cfg)
		};
	} catch {
		return null;
	} finally {
		try {
			await client.unbind();
		} catch {
			// Connection already gone.
		}
	}
}
