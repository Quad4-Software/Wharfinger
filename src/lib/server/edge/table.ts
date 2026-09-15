import type { DatabaseSync } from 'node:sqlite';
import { asDb, rawSqlite, type Db } from '$lib/server/store/driver';
import type { DeploySpec } from '$lib/shared/deploy';
import {
	EDGE_MAX_ROUTES,
	isEdgeHost,
	isEdgeUpstream,
	type EdgeRoute,
	type EdgeRouteTable,
	type EdgeTlsMode
} from '$lib/shared/edge';

interface AppRow {
	id: string;
	domains: string;
	updated_at: number;
}

interface LiveRow {
	id: string;
	spec: string;
	live_at: number | null;
	created_at: number;
}

/**
 * Cheap change stamp for one agent's route inputs: the newest
 * deploy_apps edit or release transition plus the row counts. The
 * counts keep deletions visible (a removed row can leave MAX
 * untouched). Polled on every agent request; the expensive spec
 * parsing only reruns when it moves. UNION and IN (SELECT) are not
 * portable, so the stamp is assembled from two indexed queries and
 * the MAX/SUM run in code.
 */
async function tableStamp(db: Db, agentId: string): Promise<string> {
	const apps = (await db
		.prepare('SELECT id, updated_at FROM deploy_apps WHERE agent_id = ?')
		.all(agentId)) as { id: string; updated_at: number }[];
	const stamps: number[] = apps.map((a) => a.updated_at);
	let rels = 0;
	if (apps.length > 0) {
		const marks = apps.map(() => '?').join(',');
		const relRows = (await db
			.prepare(
				`SELECT COALESCE(live_at, created_at) AS stamp FROM deploy_releases WHERE app_id IN (${marks})`
			)
			.all(...apps.map((a) => a.id))) as { stamp: number }[];
		rels = relRows.length;
		for (const r of relRows) stamps.push(r.stamp);
	}
	// The sum catches edits that land inside the same millisecond as
	// a newer row: MAX alone cannot see an updated_at that moved to a
	// value already present in the set.
	const s = stamps.length ? Math.max(...stamps) : 0;
	const total = stamps.reduce((a, b) => a + b, 0);
	return `${apps.length}:${rels}:${s}:${total}`;
}

// TLS mode emitted for every route until the app model carries a
// per-app tls field; 'manual'/'off' stay reserved in the wire type.
const DEFAULT_TLS: EdgeTlsMode = 'acme';

/**
 * Table version derived from the route payload itself. Agents only
 * ever compare it for equality (?v= / If-None-Match), so a content
 * hash is strictly safer than a timestamp: two edits landing in the
 * same millisecond still produce a different version whenever the
 * routes differ, and identical routes always answer 304.
 * Two FNV-1a streams folded to 53 bits.
 */
function routeVersion(routes: EdgeRoute[]): number {
	const s = JSON.stringify(routes);
	let h1 = 0x811c9dc5;
	let h2 = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193);
		h2 = Math.imul(h2 ^ s.charCodeAt(i), 0x85ebca6b);
	}
	return (h1 >>> 5) * 2 ** 26 + (h2 >>> 6);
}

// dns1123 label folding, mirrors agent/internal/deploy/kube.go.
function dns1123(v: string): string {
	const folded = v
		.toLowerCase()
		.split('')
		.map((c) => (/[a-z0-9]/.test(c) ? c : '-'))
		.join('')
		.replace(/^-+|-+$/g, '');
	return folded.length > 63 ? folded.slice(0, 63).replace(/^-+|-+$/g, '') : folded;
}

// Relative path segments only; mirrors the safeRel rule in
// agent/internal/deploy/spec.go.
function safeRelJoin(base: string, rel?: string): string {
	if (!rel) return base;
	const bad =
		rel === '..' ||
		rel.startsWith('../') ||
		rel.includes('/../') ||
		rel.startsWith('/') ||
		rel.startsWith('~') ||
		rel.includes('\x00') ||
		rel.includes('\n') ||
		rel.includes('\r');
	return bad ? base : `${base}/${rel.replace(/\\/g, '/')}`;
}

/**
 * Upstream the agent can dial for the app's live release.
 * podman/docker: the agent runs on the host, so the published host
 * port is the reachable address (container names only resolve inside
 * the runtime network). k8s: the stable per-app ClusterIP service
 * (<appLabel>.<namespace>) whose service ports are the spec host
 * ports; without ports there is no service, so no upstream.
 */
function upstreamFor(spec: DeploySpec): string | null {
	const hostPort = spec.run.ports[0]?.host;
	const valid =
		typeof hostPort === 'number' &&
		Number.isInteger(hostPort) &&
		hostPort >= 1 &&
		hostPort <= 65535;
	let upstream: string | null = null;
	if (valid) {
		upstream =
			spec.runtime === 'k8s'
				? `${dns1123(spec.appId)}.${spec.namespace ?? 'default'}:${hostPort}`
				: `127.0.0.1:${hostPort}`;
	}
	// Emit nothing the agent-side intake regex would reject anyway.
	return upstream !== null && isEdgeUpstream(upstream) ? upstream : null;
}

/**
 * Build the route table for one agent. Pure: every row comes from
 * the db argument. Apps are skipped when they have no domains or no
 * live release; static-source apps serve files (staticRoot, relative
 * to the agent state dir) instead of a container upstream.
 */
export async function buildRouteTable(
	db: Db | DatabaseSync,
	agentId: string
): Promise<EdgeRouteTable> {
	const d = asDb(db);
	const apps = (await d
		.prepare('SELECT id, domains, updated_at FROM deploy_apps WHERE agent_id = ? ORDER BY id')
		.all(agentId)) as unknown as AppRow[];

	// Exact-host conflicts resolve to the lowest app id so two apps
	// claiming one host route deterministically instead of depending
	// on row order. domainCheck surfaces the conflict to the panel.
	const claimed = new Set<string>();
	const routes: EdgeRoute[] = [];
	for (const app of apps) {
		let domains: string[];
		try {
			domains = JSON.parse(app.domains) as string[];
		} catch {
			continue;
		}
		const hosts = domains.filter(isEdgeHost);
		if (!hosts.length) continue;

		const live = (await d
			.prepare(
				`SELECT id, spec, live_at, created_at FROM deploy_releases
				 WHERE app_id = ? AND status = 'live' ORDER BY live_at DESC LIMIT 1`
			)
			.get(app.id)) as LiveRow | undefined;
		if (!live) continue;

		let spec: DeploySpec;
		try {
			spec = JSON.parse(live.spec) as DeploySpec;
		} catch {
			continue;
		}

		const source = spec.source;
		if (source.kind === 'static') {
			const staticRoot = safeRelJoin(`src/${app.id}`, source.subdir);
			for (const host of hosts) {
				if (claimed.has(host)) continue;
				claimed.add(host);
				routes.push({ host, appId: app.id, tls: DEFAULT_TLS, staticRoot });
			}
			continue;
		}

		const upstream = upstreamFor(spec);
		if (!upstream) continue;
		for (const host of hosts) {
			if (claimed.has(host)) continue;
			claimed.add(host);
			routes.push({ host, upstream, appId: app.id, tls: DEFAULT_TLS });
		}
	}

	routes.sort((a, b) => a.host.localeCompare(b.host));
	const capped = routes.slice(0, EDGE_MAX_ROUTES);
	return { version: routeVersion(capped), routes: capped };
}

// Per-db lazy cache: rebuild only when tableStamp moves. WeakMap so
// test dbs and the dev db never leak through this module. Callers may
// pass a Db driver or a raw DatabaseSync; the key normalizes to the
// underlying handle so both views share one cache.
const cache = new WeakMap<object, Map<string, { stamp: string; table: EdgeRouteTable }>>();

/**
 * Route table for an agent, memoized on the db handle. The stamp
 * query is one indexed scan; the full build (spec JSON parsing)
 * runs only when app or release rows changed since the last call.
 */
export async function routeTable(db: Db | DatabaseSync, agentId: string): Promise<EdgeRouteTable> {
	const d = asDb(db);
	const key = rawSqlite(db) ?? d;
	let byAgent = cache.get(key);
	if (!byAgent) {
		byAgent = new Map();
		cache.set(key, byAgent);
	}
	const stamp = await tableStamp(d, agentId);
	const hit = byAgent.get(agentId);
	if (hit?.stamp === stamp) return hit.table;
	const table = await buildRouteTable(d, agentId);
	byAgent.set(agentId, { stamp, table });
	return table;
}
