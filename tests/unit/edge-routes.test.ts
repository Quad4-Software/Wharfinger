import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { Runtime } from '$lib/server/runtime';
import { EDGE_TLS_MODES, type EdgeRouteTable } from '$lib/shared/edge';

// Same pattern as deploy-routes.test.ts: real stores on a temp db,
// ingress gates stubbed so table building and the 304 path are what
// get exercised.
const ref = vi.hoisted(() => ({ rt: undefined as unknown as Runtime }));
const proofSpy = vi.hoisted(() => vi.fn<(...args: unknown[]) => null>(() => null));

vi.mock('$lib/server/runtime', async () => {
	process.env.WHARFINGER_SECRET_KEY = 'edge-test-key-material';
	const { mkdtempSync } = await import('node:fs');
	const { join } = await import('node:path');
	const { tmpdir } = await import('node:os');
	const dir = mkdtempSync(join(tmpdir(), 'q4s-edge-routes-'));
	process.env.WHARFINGER_DATA_DIR = dir;
	const { openDb } = await import('$lib/server/store/db');
	const { JobQueue } = await import('$lib/server/jobs/queue');
	const { DeployStore } = await import('$lib/server/deploy/store');
	const db = openDb(dir);
	ref.rt = {
		jobs: new JobQueue(db),
		deploys: new DeployStore(db),
		agents: {},
		db
	} as unknown as Runtime;
	return { getRuntime: () => ref.rt };
});

vi.mock('$lib/server/ingress/http', async () => {
	const orig = await import('$lib/server/ingress/http');
	return {
		...(orig as object),
		bearerToken: () => 'tok',
		gate: () => ({ err: null, agent: { id: 'agent-1', pubkey: null } }),
		proofGate: proofSpy
	};
});

const { GET } = await import('../../src/routes/ingress/routes/+server');
const { buildRouteTable, routeTable } = await import('$lib/server/edge/table');
const { triggerDeploy } = await import('$lib/server/deploy/trigger');

function event(path: string, headers: Record<string, string> = {}): RequestEvent {
	return {
		url: new URL(`http://test${path}`),
		request: new Request(`http://test${path}`, { method: 'GET', headers })
	} as unknown as RequestEvent;
}

const GIT = { kind: 'git', url: 'https://git.example.com/org/app.git', ref: 'main' } as const;

function liveApp(
	name: string,
	opts: { domains?: string[]; agentId?: string; source?: unknown; port?: number } = {}
) {
	const { app } = ref.rt.deploys.createApp({
		name,
		agentId: opts.agentId ?? 'agent-1',
		source: (opts.source ?? GIT) as never,
		domains: opts.domains ?? [`${name}.example.com`],
		healthcheck: { kind: 'http', port: opts.port ?? 8080 }
	});
	const { releaseId } = triggerDeploy(ref.rt, app);
	ref.rt.deploys.markLive(releaseId!);
	return { app, releaseId: releaseId! };
}

describe('buildRouteTable', () => {
	it('returns an empty table for an agent with no apps', () => {
		const table = buildRouteTable(ref.rt.db, 'agent-none');
		expect(table.routes).toEqual([]);
		expect(table.version).toBeGreaterThanOrEqual(0);
	});

	it('routes each domain to the published host-port upstream', () => {
		const { app } = liveApp('webapp', {
			domains: ['web.example.com', 'www.example.com'],
			port: 8080
		});
		const table = buildRouteTable(ref.rt.db, 'agent-1');
		const mine = table.routes.filter((r) => r.appId === app.id);
		expect(mine).toHaveLength(2);
		for (const r of mine) {
			// domains + no explicit ports: the spec auto-publishes the
			// healthcheck port, so the host-resident proxy dials it.
			expect(r.upstream).toBe('127.0.0.1:8080');
			expect(EDGE_TLS_MODES).toContain(r.tls);
			expect(r.tls).toBe('acme');
			expect(r.staticRoot).toBeUndefined();
		}
		expect(mine.map((r) => r.host)).toEqual(['web.example.com', 'www.example.com']);
	});

	it('skips apps with no live release and apps with no domains', () => {
		const pending = ref.rt.deploys.createApp({
			name: 'pendingapp',
			agentId: 'agent-1',
			source: GIT,
			domains: ['pending.example.com'],
			healthcheck: { kind: 'http', port: 8080 }
		});
		ref.rt.deploys.createApp({
			name: 'nodomains',
			agentId: 'agent-1',
			source: GIT,
			domains: [],
			healthcheck: { kind: 'http', port: 8080 }
		});
		const table = buildRouteTable(ref.rt.db, 'agent-1');
		expect(table.routes.some((r) => r.appId === pending.app.id)).toBe(false);
		expect(table.routes.some((r) => r.host === 'pending.example.com')).toBe(false);
	});

	it('serves static apps from staticRoot instead of an upstream', () => {
		const { app } = liveApp('staticapp', {
			source: { kind: 'static', subdir: 'dist' },
			domains: ['static.example.com']
		});
		const table = buildRouteTable(ref.rt.db, 'agent-1');
		const route = table.routes.find((r) => r.appId === app.id);
		expect(route?.staticRoot).toBe(`src/${app.id}/dist`);
		expect(route?.upstream).toBeUndefined();
	});

	it('does not leak apps bound to another agent', () => {
		liveApp('otherapp', { agentId: 'agent-2', domains: ['other.example.com'] });
		const table = buildRouteTable(ref.rt.db, 'agent-1');
		expect(table.routes.some((r) => r.host === 'other.example.com')).toBe(false);
	});

	it('bumps the version when a domain-having app is deleted', () => {
		const { app } = liveApp('goneapp', { domains: ['gone.example.com'] });
		const before = buildRouteTable(ref.rt.db, 'agent-1').version;
		ref.rt.deploys.deleteApp(app.id);
		const after = buildRouteTable(ref.rt.db, 'agent-1');
		expect(after.version).not.toBe(before);
		expect(after.routes.some((r) => r.host === 'gone.example.com')).toBe(false);
	});

	it('memoizes per db+agent and rebuilds on change', () => {
		const t1 = routeTable(ref.rt.db, 'agent-1');
		const t2 = routeTable(ref.rt.db, 'agent-1');
		expect(t2).toBe(t1); // same object: stamp unchanged
		liveApp('newapp', { domains: ['new.example.com'] });
		const t3 = routeTable(ref.rt.db, 'agent-1');
		expect(t3).not.toBe(t1);
		expect(t3.routes.some((r) => r.host === 'new.example.com')).toBe(true);
	});
});

describe('GET /ingress/routes', () => {
	it('returns the table with an etag', async () => {
		const res = await GET(event('/ingress/routes') as never);
		expect(res.status).toBe(200);
		const table = (await res.json()) as EdgeRouteTable;
		expect(res.headers.get('etag')).toBe(String(table.version));
		expect(Array.isArray(table.routes)).toBe(true);
	});

	it('signs the request target for the proof gate', async () => {
		proofSpy.mockClear();
		await GET(event('/ingress/routes?v=5') as never);
		expect(proofSpy).toHaveBeenCalled();
		const body = proofSpy.mock.calls[0]?.[3] as Buffer;
		expect(body.toString('utf8')).toBe('GET /ingress/routes?v=5');
	});

	it('answers 304 when ?v= matches the current version', async () => {
		const first = (await (await GET(event('/ingress/routes') as never)).json()) as EdgeRouteTable;
		const res = await GET(event(`/ingress/routes?v=${first.version}`) as never);
		expect(res.status).toBe(304);
		expect(res.headers.get('etag')).toBe(String(first.version));
	});

	it('answers 304 when If-None-Match matches', async () => {
		const first = (await (await GET(event('/ingress/routes') as never)).json()) as EdgeRouteTable;
		const res = await GET(
			event('/ingress/routes', { 'if-none-match': String(first.version) }) as never
		);
		expect(res.status).toBe(304);
	});

	it('returns a fresh table when the version is stale', async () => {
		const res = await GET(event('/ingress/routes?v=1') as never);
		expect(res.status).toBe(200);
		const table = (await res.json()) as EdgeRouteTable;
		expect(table.version).toBeGreaterThan(0);
	});
});
