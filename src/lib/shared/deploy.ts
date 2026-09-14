// Deploy domain types shared by hub and panel. The wire spec the
// agent executes is DeploySpec; see .agents/skills/deploy-pipeline.

export const SOURCE_KINDS = ['git', 'image', 'static'] as const;
type SourceKind = (typeof SOURCE_KINDS)[number];

export const RUNTIMES = ['podman', 'docker', 'k8s'] as const;
export type DeployRuntime = (typeof RUNTIMES)[number];

export type ReleaseStatus = 'pending' | 'live' | 'failed' | 'rolled_back' | 'superseded';

export interface AppSource {
	kind: SourceKind;
	// git: clone url + ref; image: registry ref; static: dir in repo
	// or artifact url. Compose files are imported via the converter
	// endpoint, which expands them into linked apps.
	url?: string;
	ref?: string;
	subdir?: string;
}

export interface Healthcheck {
	kind: 'http' | 'tcp';
	port: number;
	path?: string;
	intervalMs?: number;
	timeoutMs?: number;
	retries?: number;
}

export interface PortMap {
	host: number;
	container: number;
	// Bind the published port to 127.0.0.1 only: reachable by the
	// edge proxy and the healthcheck, not from outside the host.
	local?: boolean;
}

export interface DeployApp {
	id: string;
	name: string;
	agentId: string;
	source: AppSource;
	runtime: DeployRuntime;
	domains: string[];
	healthcheck: Partial<Healthcheck>;
	// Published ports: host port on the agent, container port inside.
	// Required for edge routing and for the k8s ClusterIP service.
	ports: PortMap[];
	// k8s only: target namespace and pod replicas. Null on container
	// runtimes.
	namespace: string | null;
	replicas: number | null;
	webhook: string;
	hasEnv: boolean;
	hasHookSecret: boolean;
	hasDeployKey: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface DeployRelease {
	id: string;
	appId: string;
	jobId: number | null;
	status: ReleaseStatus;
	commit: string | null;
	image: string | null;
	createdAt: number;
	liveAt: number | null;
}

// Frozen spec baked into a deploy job. The executor parses this; the
// hub never mutates it after enqueue. env and the deploy key are NOT
// in the spec: the agent fetches them through the secrets endpoint
// with its lease, so job rows never hold secret material.
export interface DeploySpec {
	appId: string;
	releaseId: string;
	jobKey: string;
	source: AppSource;
	build: {
		kind: 'dockerfile' | 'static' | 'image';
		dockerfile?: string;
		context?: string;
	};
	run: {
		image?: string;
		ports: { host: number; container: number }[];
		healthcheck?: Healthcheck;
		envRef: string;
		// k8s only: pod replica count (1-10, default 1); the
		// container runtimes ignore it.
		replicas?: number;
	};
	route: { domains: string[] };
	runtime: DeployRuntime;
	// k8s only: target namespace, DNS-1123; empty uses the agent
	// default. Container runtimes ignore it.
	namespace?: string;
	prevRelease?: { id: string; container: string; image: string | null };
	rollbackOf?: string;
}

export interface DomainConflict {
	appId: string;
	name: string;
	host: string;
}

// DNS preflight report for one app domain; produced by the
// domain-check endpoint.
export interface DomainReport {
	host: string;
	wildcard: boolean;
	// ok: answered; unresolved: NXDOMAIN/ENODATA/timeout; skipped for
	// inputs that are not literal hostnames.
	dns: 'ok' | 'unresolved' | 'skipped';
	cname: string | null;
	addresses: string[];
	// true when a resolved address is one the agent reports on a real
	// interface; null when the agent has not reported addresses yet.
	pointsAtAgent: boolean | null;
	// Every answer is loopback/RFC1918/CGNAT/ULA/link-local: public
	// ACME validation can never reach it.
	privateOnly: boolean;
	conflicts: DomainConflict[];
	suggestions: string[];
}
