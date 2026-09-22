// Forwarded-header trust policy for the production wrapper and ws
// bridges. Mirrors src/lib/server/proxy.ts (the SvelteKit side); keep
// the two files in sync. WHARFINGER_TRUST_PROXY:
//   unset/other      never trust forwarded headers
//   all|true|yes|1   always trust (edge proxy overwrites them)
//   loopback|local   trust only a same-host proxy
//   lan|private      trust loopback plus private/link-local peers

function proxyTrustMode(env = process.env) {
	const v = (env.WHARFINGER_TRUST_PROXY ?? '').trim().toLowerCase();
	if (['1', 'true', 'yes', 'all', 'always'].includes(v)) return 'all';
	if (['loopback', 'local'].includes(v)) return 'loopback';
	if (['lan', 'private'].includes(v)) return 'lan';
	return 'never';
}

function unmap(addr) {
	return addr.toLowerCase().startsWith('::ffff:') ? addr.slice(7) : addr.toLowerCase();
}

function isLoopbackAddr(addr) {
	const a = unmap(addr);
	if (a === '::1') return true;
	const p = a.split('.');
	return p.length === 4 && p[0] === '127';
}

function isPrivateAddr(addr) {
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

export function trustForwarded(peer, env) {
	const mode = proxyTrustMode(env);
	if (mode === 'all') return true;
	if (!peer) return false;
	if (mode === 'loopback') return isLoopbackAddr(peer);
	if (mode === 'lan') return isPrivateAddr(peer);
	return false;
}
