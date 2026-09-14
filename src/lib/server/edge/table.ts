import type { DatabaseSync } from 'node:sqlite';
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
 * parsing only reruns when it moves.
 */
function tableStamp(db: DatabaseSync, agentId: string): string {
	const row = db
		.prepare(
			`SELECT
				(SELECT COUNT(*) FROM deploy_apps WHERE agent_id = ?) AS apps,
				(SELECT COUNT(*) FROM deploy_releases
					WHERE app_id IN (SELECT id FROM deploy_apps WHERE agent_id = ?)) AS rels,
				(SELECT MAX(stamp) FROM (
					SELECT updated_at AS stamp FROM deploy_apps WHERE agent_id = ?
					UNION ALL
					SELECT COALESCE(live_at, created_at) AS stamp FROM deploy_releases
					WHERE app_id IN (SELECT id FROM deploy_apps WHERE agent_id = ?)
				)) AS s,
				(SELECT SUM(stamp) FROM (
					SELECT updated_at AS stamp FROM deploy_apps WHERE agent_id = ?
					UNION ALL
					SELECT COALESCE(live_at, created_at) AS stamp FROM deploy_releases
					WHERE app_id IN (SELECT id FROM deploy_apps WHERE agent_id = ?)
				)) AS total`
		)
		.get(agentId, agentId, agentId, agentId, agentId, agentId) as {
		apps: number;
		rels: number;
		s: number | null;
		total: number | null;
	};
	// The sum catches edits that land inside the same millisecond as
	// a newer row: MAX alone cannot see an updated_at that moved to a
	// value already present in the set.
	return `${row.apps}:${row.rels}:${row.s ?? 0}:${row.total ?? 0}`;
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
export function buildRouteTable(db: DatabaseSync, agentId: string): EdgeRouteTable {
	const apps = db
		.prepare('SELECT id, domains, updated_at FROM deploy_apps WHERE agent_id = ?')
		.all(agentId) as unknown as AppRow[];

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

		const live = db
			.prepare(
				`SELECT id, spec, live_at, created_at FROM deploy_releases
				 WHERE app_id = ? AND status = 'live' ORDER BY live_at DESC LIMIT 1`
			)
			.get(app.id) as LiveRow | undefined;
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
				routes.push({ host, appId: app.id, tls: DEFAULT_TLS, staticRoot });
			}
			continue;
		}

		const upstream = upstreamFor(spec);
		if (!upstream) continue;
		for (const host of hosts) {
			routes.push({ host, upstream, appId: app.id, tls: DEFAULT_TLS });
		}
	}

	routes.sort((a, b) => a.host.localeCompare(b.host));
	const capped = routes.slice(0, EDGE_MAX_ROUTES);
	return { version: routeVersion(capped), routes: capped };
}

// Per-db lazy cache: rebuild only when tableStamp moves. WeakMap so
// test dbs and the dev db never leak through this module.
const cache = new WeakMap<DatabaseSync, Map<string, { stamp: string; table: EdgeRouteTable }>>();

/**
 * Route table for an agent, memoized on the db handle. The stamp
 * query is one indexed MAX scan; the full build (spec JSON parsing)
 * runs only when app or release rows changed since the last call.
 */
export function routeTable(db: DatabaseSync, agentId: string): EdgeRouteTable {
	let byAgent = cache.get(db);
	if (!byAgent) {
		byAgent = new Map();
		cache.set(db, byAgent);
	}
	const stamp = tableStamp(db, agentId);
	const hit = byAgent.get(agentId);
	if (hit?.stamp === stamp) return hit.table;
	const table = buildRouteTable(db, agentId);
	byAgent.set(agentId, { stamp, table });
	return table;
}
