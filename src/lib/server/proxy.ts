/**
 * Forwarded-header trust policy. WHARFINGER_TRUST_PROXY picks which
 * socket peers may supply X-Forwarded-For/X-Real-IP/X-Forwarded-Proto:
 *
 *   unset/other      never trust; the socket address is authoritative
 *   all|true|yes|1   always trust (deployment behind a proxy that
 *                    overwrites forwarded headers on the edge)
 *   loopback|local   trust only when the direct peer is loopback
 *                    (proxy on the same host)
 *   lan|private      trust loopback plus private/link-local peers
 *                    (reverse proxy elsewhere on the LAN)
 *
 * server/net.mjs mirrors this for the production ws bridges, which
 * cannot import TypeScript.
 */
export type ProxyTrust = 'never' | 'loopback' | 'lan' | 'all';

export function proxyTrustMode(env: NodeJS.ProcessEnv = process.env): ProxyTrust {
	const v = (env.WHARFINGER_TRUST_PROXY ?? '').trim().toLowerCase();
	if (['1', 'true', 'yes', 'all', 'always'].includes(v)) return 'all';
	if (['loopback', 'local'].includes(v)) return 'loopback';
	if (['lan', 'private'].includes(v)) return 'lan';
	return 'never';
}

/** Strip the IPv4-mapped prefix so ::ffff:10.0.0.1 tests as 10.0.0.1. */
function unmap(addr: string): string {
	return addr.toLowerCase().startsWith('::ffff:') ? addr.slice(7) : addr.toLowerCase();
}

export function isLoopbackAddr(addr: string): boolean {
	const a = unmap(addr);
	if (a === '::1') return true;
	const p = a.split('.');
	return p.length === 4 && p[0] === '127';
}

/** RFC1918, CGNAT, link-local, ULA, and loopback: anything a LAN proxy would be. */
export function isPrivateAddr(addr: string): boolean {
	const a = unmap(addr);
	if (isLoopbackAddr(a)) return true;
	if (a.includes(':')) {
		return a === '::' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
	}
	const p = a.split('.').map(Number);
	if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
	const [a0, a1] = p;
	return (
		a0 === 10 ||
		a0 === 0 ||
		(a0 === 172 && a1 >= 16 && a1 <= 31) ||
		(a0 === 192 && a1 === 168) ||
		(a0 === 169 && a1 === 254) ||
		(a0 === 100 && a1 >= 64 && a1 <= 127)
	);
}

/** Whether forwarded headers may be trusted for this socket peer. */
export function trustForwarded(peer: string | null | undefined, env?: NodeJS.ProcessEnv): boolean {
	const mode = proxyTrustMode(env);
	if (mode === 'all') return true;
	if (!peer) return false;
	if (mode === 'loopback') return isLoopbackAddr(peer);
	if (mode === 'lan') return isPrivateAddr(peer);
	return false;
}
