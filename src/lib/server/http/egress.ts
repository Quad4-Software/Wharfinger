import { lookup as dnsLookup } from 'node:dns';
import { isIP, isIPv4, type LookupFunction } from 'node:net';
import { Agent, type Dispatcher } from 'undici';

// Outbound egress guard for monitor checks and notification sends.
// Link-local space is blocked because it is where cloud metadata
// endpoints live (169.254.169.254 on AWS/GCP/Azure, 169.254.170.2 on
// ECS, fd00:ec2::254 for AWS IPv6). Loopback and RFC1918 stay allowed:
// monitoring services on the LAN and on the same host is the core use
// case of a self-hosted status page.

export const EGRESS_BLOCKED_DETAIL = 'blocked by egress policy (link-local target)';

// Well-known cloud metadata addresses beyond the link-local ranges.
const BLOCKED_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.goog', 'metadata']);

function blockedIpv4(ip: string): boolean {
	const [a, b, c, d] = ip.split('.').map(Number);
	return (
		// 169.254.0.0/16 link-local, incl. cloud metadata endpoints.
		(a === 169 && b === 254) ||
		// "This host" pseudo addresses.
		a === 0 ||
		// Alibaba Cloud metadata.
		(a === 100 && b === 100 && c === 100 && d === 200)
	);
}

/**
 * IPv4 embedded in the trailing 32 bits of a translation prefix,
 * either dotted (64:ff9b::169.254.1.1) or hex (64:ff9b::a9fe:0101).
 */
function embeddedIpv4(rest: string): string | null {
	if (rest.includes('.')) return rest;
	const parts = rest.split(':');
	if (parts.length < 1 || parts.length > 2) return null;
	const [hi, lo] = parts.map((h) => parseInt(h, 16));
	if (Number.isNaN(hi)) return null;
	const loV = Number.isNaN(lo) ? 0 : lo;
	return `${(hi >> 8) & 255}.${hi & 255}.${(loV >> 8) & 255}.${loV & 255}`;
}

function blockedIpv6(ip: string): boolean {
	const n = ip.toLowerCase();
	if (n.startsWith('::ffff:')) {
		// IPv4-mapped form, dotted (::ffff:169.254.1.1) or hex
		// (::ffff:a9fe:0101).
		const v4 = embeddedIpv4(n.slice(7));
		return v4 !== null && blockedIpv4(v4);
	}
	// NAT64 well-known 64:ff9b::/96 and local-use 64:ff9b:1::/48 embed
	// the translated IPv4 in the low bits; on a NAT64 network the
	// literal otherwise sails past the v4 checks.
	for (const prefix of ['64:ff9b::', '64:ff9b:1::', '64:ff9b:1:0:']) {
		if (n.startsWith(prefix)) {
			const v4 = embeddedIpv4(n.slice(prefix.length));
			return v4 !== null && blockedIpv4(v4);
		}
	}
	// Unspecified, link-local fe80::/10, AWS IPv6 metadata.
	return n === '::' || /^fe[89ab]/.test(n) || n === 'fd00:ec2::254';
}

export function blockedIp(ip: string): boolean {
	return isIPv4(ip) ? blockedIpv4(ip) : blockedIpv6(ip);
}

/** Literal-IP or known-metadata hostname check, before any DNS work. */
export function blockedHost(hostname: string): boolean {
	const h = hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, '')
		.replace(/\.$/, '');
	if (BLOCKED_HOSTNAMES.has(h)) return true;
	return isIP(h) !== 0 && blockedIp(h);
}

/**
 * DNS lookup that rejects resolutions into blocked ranges. Validating
 * inside the lookup callback (whose result is what the socket connects
 * to) avoids the DNS-rebinding window a resolve-then-connect check
 * would leave open.
 */
function guardedLookup(allowLinkLocal: () => boolean): LookupFunction {
	return (hostname, options, callback) => {
		dnsLookup(hostname, options, (err, address, family) => {
			if (err) {
				callback(err, address, family);
				return;
			}
			const ips = Array.isArray(address) ? address.map((a) => a.address) : [address];
			if (!allowLinkLocal() && ips.some((ip) => blockedIp(ip))) {
				const e = new Error(EGRESS_BLOCKED_DETAIL) as NodeJS.ErrnoException;
				e.code = 'EAI_BLOCKED';
				callback(e, address, family);
				return;
			}
			callback(null, address, family);
		});
	};
}

/** RequestInit with undici's dispatcher field (absent from DOM types). */
export type FetchInit = RequestInit & { dispatcher: Dispatcher };

export interface Egress {
	/** Shared undici dispatcher; pass as fetch({ dispatcher }). */
	dispatcher: Dispatcher;
	/** Validating lookup for net.connect({ lookup }) callers. */
	lookup: LookupFunction;
	/** Current policy, resolved at call time so config reloads apply. */
	allowLinkLocal(): boolean;
}

/**
 * One egress policy shared by the HTTP checkers, TCP probes, and
 * notification senders. allowLinkLocal is a live accessor so a config
 * reload takes effect without rebuilding connections.
 */
export function makeEgress(allowLinkLocal: () => boolean): Egress {
	const lookup = guardedLookup(allowLinkLocal);
	return {
		dispatcher: new Agent({ connect: { lookup } }),
		lookup,
		allowLinkLocal
	};
}
