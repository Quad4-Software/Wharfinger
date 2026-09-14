import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { openDb } from '$lib/server/store/db';
import { DeployStore } from '$lib/server/deploy/store';
import { domainCheck } from '$lib/server/deploy/dns';
import type { Runtime } from '$lib/server/runtime';
import type { DeployApp } from '$lib/shared/deploy';
import type { Permission } from '$lib/server/admin/authz';
import type { User } from '$lib/server/admin/users';

process.env.WHARFINGER_SECRET_KEY = 'unit-test-secret-key-material';

interface Zone {
	a?: Record<string, string[]>;
	aaaa?: Record<string, string[]>;
	cname?: Record<string, string[]>;
}

// The route constructs a real Resolver; steer it to a fixture zone.
const routeZone = vi.hoisted((): { zone: Zone } => ({ zone: {} }));
vi.mock('node:dns/promises', () => ({
	Resolver: class {
		resolve4(h: string): Promise<string[]> {
			return Promise.resolve(routeZone.zone.a?.[h] ?? []);
		}
		resolve6(h: string): Promise<string[]> {
			return Promise.resolve(routeZone.zone.aaaa?.[h] ?? []);
		}
		resolveCname(h: string): Promise<string[]> {
			return Promise.resolve(routeZone.zone.cname?.[h] ?? []);
		}
	}
}));

function fakeResolver(zone: Zone) {
	const look = (table: Record<string, string[]> | undefined, host: string) =>
		Promise.resolve(table?.[host] ?? []);
	return {
		resolve4: (h: string) => look(zone.a, h),
		resolve6: (h: string) => look(zone.aaaa, h),
		resolveCname: (h: string) => look(zone.cname, h)
	};
}

function stores(agentAddrs: string[] | null = ['203.0.113.10', '2001:db8::10']) {
	const db = openDb(mkdtempSync(join(tmpdir(), 'wharfinger-dns-')));
	const deploys = new DeployStore(db);
	const agents = {
		get: () =>
			agentAddrs === null
				? null
				: { id: 'agent-1', lastPayload: { net: { addresses: agentAddrs } } }
	};
	const rt = { db, deploys, agents } as unknown as Runtime;
	return { deploys, rt };
}

const GIT = { kind: 'git' as const, url: 'git@github.com:org/repo.git', ref: 'main' };

function makeApp(deploys: DeployStore, domains: string[], name = 'site'): DeployApp {
	return deploys.createApp({ name, agentId: 'agent-1', source: GIT, domains }).app;
}

describe('domainCheck', () => {
	it('reports an apex host pointing at the agent', async () => {
		const { deploys, rt } = stores();
		const app = makeApp(deploys, ['app.example.com']);
		const reports = await domainCheck(rt, app, {
			resolver: fakeResolver({ a: { 'app.example.com': ['203.0.113.10'] } })
		});
		const r = reports[0];
		expect(r.dns).toBe('ok');
		expect(r.addresses).toEqual(['203.0.113.10']);
		expect(r.pointsAtAgent).toBe(true);
		expect(r.privateOnly).toBe(false);
		expect(r.conflicts).toEqual([]);
		expect(r.suggestions).toEqual([]);
	});

	it('suggests an A record with the agent public address on NXDOMAIN', async () => {
		const { deploys, rt } = stores();
		const app = makeApp(deploys, ['missing.example.com']);
		const reports = await domainCheck(rt, app, { resolver: fakeResolver({}) });
		const r = reports[0];
		expect(r.dns).toBe('unresolved');
		expect(r.suggestions[0]).toContain('203.0.113.10');
	});

	it('flags answers that do not match any agent address', async () => {
		const { deploys, rt } = stores();
		const app = makeApp(deploys, ['app.example.com']);
		const reports = await domainCheck(rt, app, {
			resolver: fakeResolver({ a: { 'app.example.com': ['198.51.100.9'] } })
		});
		const r = reports[0];
		expect(r.pointsAtAgent).toBe(false);
		expect(r.suggestions.join(' ')).toContain('ACME');
	});

	it('follows a cname chain to its target', async () => {
		const { deploys, rt } = stores();
		const app = makeApp(deploys, ['www.example.com']);
		const reports = await domainCheck(rt, app, {
			resolver: fakeResolver({
				cname: { 'www.example.com': ['edge.example.net'] },
				a: { 'edge.example.net': ['203.0.113.10'] }
			})
		});
		const r = reports[0];
		expect(r.cname).toBe('edge.example.net');
		expect(r.pointsAtAgent).toBe(true);
	});

	it('marks malformed stored hosts as skipped', async () => {
		const { deploys, rt } = stores();
		const app = makeApp(deploys, ['ok.example.com']);
		// Simulate a legacy row whose stored value predates validation.
		app.domains.push('not a host!');
		const reports = await domainCheck(rt, app, {
			resolver: fakeResolver({ a: { 'ok.example.com': ['203.0.113.10'] } })
		});
		expect(reports[1].dns).toBe('skipped');
		expect(reports[1].suggestions[0]).toContain('not a routable hostname');
	});

	it('probes a wildcard with an unlikely label under the base', async () => {
		const { deploys, rt } = stores();
		const app = makeApp(deploys, ['*.example.com']);
		const reports = await domainCheck(rt, app, {
			resolver: fakeResolver({ a: { '_wf-check.example.com': ['203.0.113.10'] } })
		});
		const r = reports[0];
		expect(r.wildcard).toBe(true);
		expect(r.dns).toBe('ok');
		expect(r.pointsAtAgent).toBe(true);
	});

	it('warns when a wildcard record is absent', async () => {
		const { deploys, rt } = stores();
		const app = makeApp(deploys, ['*.example.com']);
		const reports = await domainCheck(rt, app, { resolver: fakeResolver({}) });
		expect(reports[0].dns).toBe('unresolved');
		expect(reports[0].suggestions.join(' ')).toContain('A/AAAA');
	});

	it('warns on private-only answers', async () => {
		const { deploys, rt } = stores(['10.0.0.5']);
		const app = makeApp(deploys, ['internal.lan']);
		const reports = await domainCheck(rt, app, {
			resolver: fakeResolver({ a: { 'internal.lan': ['10.0.0.5'] } })
		});
		const r = reports[0];
		expect(r.privateOnly).toBe(true);
		expect(r.pointsAtAgent).toBe(true);
		expect(r.suggestions.join(' ')).toContain('DNS-01');
	});

	it('reports exact-host and covering-wildcard conflicts', async () => {
		const { deploys, rt } = stores();
		makeApp(deploys, ['app.example.com'], 'first');
		const app = makeApp(deploys, ['app.example.com'], 'second');
		const reports = await domainCheck(rt, app, {
			resolver: fakeResolver({ a: { 'app.example.com': ['203.0.113.10'] } })
		});
		expect(reports[0].conflicts).toHaveLength(1);
		expect(reports[0].conflicts[0]).toMatchObject({ name: 'first', host: 'app.example.com' });
		expect(reports[0].suggestions.join(' ')).toContain('first claim wins');

		// A wildcard on another app covers an exact host claim.
		makeApp(deploys, ['*.svc.example.com'], 'wild');
		const sub = makeApp(deploys, ['api.svc.example.com'], 'api');
		const r2 = await domainCheck(rt, sub, {
			resolver: fakeResolver({ a: { 'api.svc.example.com': ['203.0.113.10'] } })
		});
		expect(r2[0].conflicts.map((c) => c.name)).toEqual(['wild']);
	});

	it('treats null agent payload as unknown rather than wrong', async () => {
		const { deploys, rt } = stores(null);
		const app = makeApp(deploys, ['app.example.com']);
		const reports = await domainCheck(rt, app, {
			resolver: fakeResolver({ a: { 'app.example.com': ['198.51.100.9'] } })
		});
		expect(reports[0].pointsAtAgent).toBeNull();
		expect(reports[0].suggestions.join(' ')).not.toContain('ACME');
	});
});

const { GET: domainCheckRoute } =
	await import('../../src/routes/admin/api/deploy/apps/[id]/domain-check/+server');

const admin: User = {
	id: 1,
	username: 'root',
	displayName: '',
	role: 'admin',
	totpEnabled: false,
	createdAt: 0,
	disabledAt: null,
	lastLoginAt: null
};

function routeEvent(id: string, perms: Permission[] = ['deploy.view']): RequestEvent {
	return {
		locals: { user: admin, perms: new Set(perms) },
		params: { id },
		url: new URL(`http://test/admin/api/deploy/apps/${id}/domain-check`),
		request: new Request(`http://test/admin/api/deploy/apps/${id}/domain-check`)
	} as unknown as RequestEvent;
}

// The route reads rt via getRuntime; share the same stores.
const routeRt = vi.hoisted(() => ({ rt: undefined as unknown as Runtime }));
vi.mock('$lib/server/runtime', () => ({ getRuntime: () => routeRt.rt }));

describe('domain-check route', () => {
	it('denies without deploy.view, 404s a missing app, and checks a real one', async () => {
		const { deploys, rt } = stores();
		routeRt.rt = rt;
		const app = makeApp(deploys, ['edge.example.com']);
		routeZone.zone = { a: { 'edge.example.com': ['203.0.113.10'] } };

		await expect(domainCheckRoute(routeEvent(app.id, []) as never)).rejects.toMatchObject({
			status: 403
		});
		expect((await domainCheckRoute(routeEvent('missing') as never)).status).toBe(404);

		const res = await domainCheckRoute(routeEvent(app.id) as never);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { checks: { host: string; dns: string }[] };
		expect(body.checks).toEqual([expect.objectContaining({ host: 'edge.example.com', dns: 'ok' })]);
	});
});
