// Smart domain configuration: DNS preflight, suggested records,
// wildcard detection, and cross-app host conflicts. Runs entirely
// hub-side; the only outbound traffic is bounded DNS lookups through
// the system resolver.
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Runtime } from '$lib/server/runtime';
import type { DeployApp, DomainConflict, DomainReport } from '$lib/shared/deploy';
import { isEdgeHost } from '$lib/shared/edge';

interface DnsResolver {
	resolve4(host: string): Promise<string[]>;
	resolve6(host: string): Promise<string[]>;
	resolveCname(host: string): Promise<string[]>;
}

function isPrivateIp(ip: string): boolean {
	if (isIP(ip) === 4) {
		const [a, b] = ip.split('.').map(Number);
		return (
			a === 10 ||
			a === 127 ||
			a === 0 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 100 && b >= 64 && b <= 127)
		);
	}
	const n = ip.toLowerCase();
	return (
		n === '::' ||
		n === '::1' ||
		n.startsWith('::ffff:') ||
		/^fe[89ab]/.test(n) ||
		n.startsWith('fc') ||
		n.startsWith('fd')
	);
}

// Whether `*.base` covers host. A wildcard covers only labels below
// the base, never the apex itself.
function wildcardCovers(wild: string, host: string): boolean {
	const base = wild.slice(2);
	return host.endsWith(`.${base}`) && host.length > base.length + 1;
}

/** Other apps claiming the same literal host; wildcard layering is legal. */
function conflictsForApps(apps: DeployApp[], app: DeployApp, host: string): DomainConflict[] {
	const out: DomainConflict[] = [];
	for (const other of apps) {
		if (other.id === app.id) continue;
		for (const d of other.domains) {
			const clash = d === host || (!host.startsWith('*.') && wildcardCovers(d, host));
			if (clash) {
				out.push({ appId: other.id, name: other.name, host: d });
				break;
			}
		}
	}
	return out;
}

/** Global-scope addresses the agent last reported, if any. */
async function agentAddresses(rt: Runtime, app: DeployApp): Promise<string[] | null> {
	const payload = (await rt.agents.get(app.agentId))?.lastPayload;
	const net = (payload as { net?: { addresses?: unknown } } | null)?.net;
	if (!Array.isArray(net?.addresses)) return null;
	return net.addresses.filter((a): a is string => typeof a === 'string');
}

async function resolveHost(
	resolver: DnsResolver,
	host: string
): Promise<Pick<DomainReport, 'dns' | 'cname' | 'addresses'>> {
	const cname = await resolver.resolveCname(host).catch(() => [] as string[]);
	const target = cname[0] ?? host;
	const [v4, v6] = await Promise.all([
		resolver.resolve4(target).catch(() => [] as string[]),
		resolver.resolve6(target).catch(() => [] as string[])
	]);
	const addresses = [...v4, ...v6];
	return {
		dns: addresses.length ? 'ok' : 'unresolved',
		cname: cname[0] ?? null,
		addresses
	};
}

/**
 * Per-domain report for one app. The resolver is injectable so tests
 * never touch real DNS.
 */
export async function domainCheck(
	rt: Runtime,
	app: DeployApp,
	opts: { resolver?: DnsResolver } = {}
): Promise<DomainReport[]> {
	const resolver = opts.resolver ?? new Resolver({ timeout: 3000, tries: 1 });
	const agentAddrs = await agentAddresses(rt, app);
	const apps = await rt.deploys.listApps();
	const reports: DomainReport[] = [];

	for (const host of app.domains) {
		const report: DomainReport = {
			host,
			wildcard: host.startsWith('*.'),
			dns: 'skipped',
			cname: null,
			addresses: [],
			pointsAtAgent: null,
			privateOnly: false,
			conflicts: conflictsForApps(apps, app, host),
			suggestions: []
		};
		const valid = isEdgeHost(host);
		if (!valid) {
			report.suggestions.push(`${report.host}: not a routable hostname; fix or remove it`);
			reports.push(report);
			continue;
		}
		if (report.wildcard) {
			// A wildcard record resolves any label under the base; probe
			// an unlikely one rather than the literal "*.base".
			const base = host.slice(2);
			const probe = await resolveHost(resolver, `_wf-check.${base}`);
			report.dns = probe.dns;
			report.addresses = probe.addresses;
			report.cname = probe.cname;
		} else {
			const r = await resolveHost(resolver, host);
			report.dns = r.dns;
			report.cname = r.cname;
			report.addresses = r.addresses;
		}

		report.privateOnly =
			report.addresses.length > 0 && report.addresses.every((a) => isPrivateIp(a));
		if (agentAddrs !== null && report.addresses.length > 0) {
			const mine = new Set(agentAddrs);
			report.pointsAtAgent = report.addresses.some((a) => mine.has(a));
		}

		if (report.conflicts.length) {
			const names = report.conflicts.map((c) => `${c.name} (${c.host})`).join(', ');
			report.suggestions.push(`host also claimed by ${names}; the first claim wins routing`);
		}
		if (report.dns === 'unresolved') {
			const target = agentAddrs?.find((a) => !isPrivateIp(a));
			report.suggestions.push(
				target
					? `no DNS answer; create an A/AAAA record for ${host} pointing at ${target}`
					: `no DNS answer; create an A/AAAA record for ${host} pointing at this system's public address`
			);
		}
		if (report.pointsAtAgent === false) {
			report.suggestions.push(
				`resolves to ${report.addresses.join(', ')} but the agent reports different addresses; ACME issuance will fail until DNS points at this system`
			);
		}
		if (report.privateOnly) {
			report.suggestions.push(
				'resolves only to private space; ACME HTTP-01 cannot reach it — use DNS-01 or a manual cert'
			);
		}
		reports.push(report);
	}
	return reports;
}
