// Edge routing domain types shared by hub, panel, and the agent.
// The hub publishes one EdgeRouteTable per agent via
// GET /ingress/routes; the agent swaps it atomically and serves the
// declared domains. Wire compatibility with agent/internal/edge.

// Hard cap on routes per agent table; keeps the polled payload
// bounded and the agent's host matching cheap.
export const EDGE_MAX_ROUTES = 200;

export const EDGE_TLS_MODES = ['acme', 'manual', 'off'] as const;
export type EdgeTlsMode = (typeof EDGE_TLS_MODES)[number];

/**
 * One domain served by an agent. Exactly one of upstream/staticRoot
 * is set: upstream is the host:port of the live container
 * (<appId>-<releaseId>:<containerPort> on the agent's container
 * network), staticRoot is a path relative to the agent state dir for
 * statically served apps.
 */
export interface EdgeRoute {
	host: string;
	upstream?: string;
	appId: string;
	tls: EdgeTlsMode;
	staticRoot?: string;
}

/**
 * Versioned route table. version is an opaque content stamp (a hash
 * of the routes); agents send it back via ?v= or If-None-Match and
 * get a 304 when unchanged.
 */
export interface EdgeRouteTable {
	version: number;
	routes: EdgeRoute[];
}

export const EDGE_CERT_STATUSES = ['valid', 'expiring', 'expired', 'pending'] as const;
type EdgeCertStatus = (typeof EDGE_CERT_STATUSES)[number];

/**
 * Cert inventory entry the agent reports for each managed host.
 * expiresAt is epoch ms; status is derived from the remaining
 * lifetime (expiring inside the renewal window).
 */
export interface EdgeCertInfo {
	host: string;
	expiresAt: number;
	issuer: string;
	status: EdgeCertStatus;
}

// Hostname or single leading-label wildcard (*.example.com).
const EDGE_HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

// host:port where host is a hostname, ipv4, or container name.
const EDGE_UPSTREAM_RE = /^[a-z0-9][a-z0-9._-]*:[0-9]{1,5}$/i;

export function isEdgeHost(v: unknown): v is string {
	return typeof v === 'string' && v.length > 0 && v.length <= 253 && EDGE_HOST_RE.test(v);
}

export function isEdgeUpstream(v: unknown): v is string {
	if (typeof v !== 'string' || !EDGE_UPSTREAM_RE.test(v)) return false;
	const port = Number(v.slice(v.lastIndexOf(':') + 1));
	return port >= 1 && port <= 65535;
}
