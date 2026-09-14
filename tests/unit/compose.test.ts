import { describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { RequestEvent } from '@sveltejs/kit';
import type { Runtime } from '$lib/server/runtime';
import type { Permission } from '$lib/server/admin/authz';
import type { User } from '$lib/server/admin/users';
import { parseCompose } from '$lib/server/deploy/compose';

// Fake a runtime backed by real stores on a temp db so the compose
// import route exercises the same tables the stores use.
const ref = vi.hoisted(() => ({
	db: undefined as unknown as DatabaseSync,
	rt: undefined as unknown as Runtime
}));

vi.mock('$lib/server/runtime', async () => {
	process.env.WHARFINGER_SECRET_KEY = 'compose-test-key-material';
	const { mkdtempSync } = await import('node:fs');
	const { join } = await import('node:path');
	const { tmpdir } = await import('node:os');
	const dir = mkdtempSync(join(tmpdir(), 'q4s-compose-'));
	const { openDb } = await import('$lib/server/store/db');
	const { JobQueue } = await import('$lib/server/jobs/queue');
	const { DeployStore } = await import('$lib/server/deploy/store');
	const { AuditStore } = await import('$lib/server/admin/audit');
	const db = openDb(dir);
	ref.db = db;
	ref.rt = {
		db,
		jobs: new JobQueue(db),
		deploys: new DeployStore(db),
		audit: new AuditStore(db),
		agents: { get: (id: string) => (id === 'agent-1' ? { id } : null) }
	} as unknown as Runtime;
	return { getRuntime: () => ref.rt };
});

const { POST: importCompose } =
	await import('../../src/routes/admin/api/deploy/apps/compose/+server');
const { getGroupStore } = await import('$lib/server/groups/store');

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

function event(body: unknown, perms: Permission[] = ['deploy.manage']): RequestEvent {
	return {
		locals: { user: admin, perms: new Set(perms) },
		params: {},
		url: new URL('http://test/admin/api/deploy/apps/compose'),
		request: new Request('http://test/admin/api/deploy/apps/compose', {
			method: 'POST',
			body: JSON.stringify(body)
		}),
		getClientAddress: () => '127.0.0.1'
	} as unknown as RequestEvent;
}

async function json(res: Response): Promise<Record<string, never>> {
	return (await res.json()) as Record<string, never>;
}

const SIMPLE = `
name: shop
services:
  web:
    image: ghcr.io/acme/web:1.2.3
    ports:
      - "8080:80"
      - "127.0.0.1:9090:9090"
    environment:
      - MODE=prod
      - DEBUG=false
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:8080/health"]
      interval: 30s
      retries: 3
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data
    depends_on:
      - web
volumes:
  pgdata: {}
`;

describe('parseCompose', () => {
	it('converts services to app drafts with ports, env, and healthcheck', () => {
		const plan = parseCompose(SIMPLE);
		expect(plan.project).toBe('shop');
		expect(plan.services).toHaveLength(2);

		const web = plan.services.find((s) => s.name === 'web')!;
		expect(web.source).toEqual({ kind: 'image', url: 'ghcr.io/acme/web:1.2.3' });
		expect(web.ports).toEqual([
			{ host: 8080, container: 80 },
			{ host: 9090, container: 9090, local: true }
		]);
		expect(web.env).toEqual({ MODE: 'prod', DEBUG: 'false' });
		expect(web.healthcheck).toMatchObject({
			kind: 'http',
			port: 8080,
			path: '/health',
			intervalMs: 30_000,
			retries: 3
		});
		expect(web.error).toBeUndefined();

		const db = plan.services.find((s) => s.name === 'db')!;
		expect(db.source).toEqual({ kind: 'image', url: 'postgres:16' });
		// volumes and depends_on must be loud, not dropped.
		expect(db.unsupported).toContain('volumes');
		expect(db.notes.some((n) => n.startsWith('depends_on'))).toBe(true);
		expect(plan.warnings.some((w) => w.startsWith('top-level volumes'))).toBe(true);
	});

	it('flags a service with no image and no build', () => {
		const plan = parseCompose(`services:\n  app:\n    command: run\n`);
		expect(plan.services[0].error).toMatch(/no image/);
		expect(plan.services[0].unsupported).toContain('command');
	});

	it('converts a git build context and rejects a local one', () => {
		const plan = parseCompose(`
services:
  ok:
    build: https://git.example.com/org/app.git#main
  bad:
    build: ./local
`);
		const ok = plan.services.find((s) => s.name === 'ok')!;
		expect(ok.source).toEqual({
			kind: 'git',
			url: 'https://git.example.com/org/app.git',
			ref: 'main'
		});
		const bad = plan.services.find((s) => s.name === 'bad')!;
		expect(bad.error).toMatch(/local dir|not a git url/);
	});

	it('handles port variants without dropping them silently', () => {
		const plan = parseCompose(`
services:
  svc:
    image: img:1
    ports:
      - "8080-8082:80"
      - "5353:53/udp"
      - target: 443
        published: 8443
        host_ip: 127.0.0.1
`);
		const svc = plan.services[0];
		expect(svc.ports).toEqual([
			{ host: 8080, container: 80 },
			{ host: 5353, container: 53 },
			{ host: 8443, container: 443, local: true }
		]);
		expect(svc.notes.some((n) => n.includes('range'))).toBe(true);
		expect(svc.notes.some((n) => n.includes('udp'))).toBe(true);
	});

	it('accepts map-form environment', () => {
		const plan = parseCompose(
			`services:\n  s:\n    image: i:1\n    environment:\n      A: "1"\n      B: two\n`
		);
		expect(plan.services[0].env).toEqual({ A: '1', B: 'two' });
	});

	it('reports yaml errors and missing services', () => {
		expect(parseCompose('services: [').warnings[0]).toMatch(/^yaml:/);
		expect(parseCompose('version: "3"\nservices: {}').warnings).toContain('no services found');
	});
});

describe('compose import route', () => {
	it('preview returns the plan without creating apps', async () => {
		const res = await importCompose(
			event({ compose: SIMPLE, agentId: 'agent-1', preview: true }) as never
		);
		const body = await json(res);
		expect(res.status).toBe(200);
		expect((body.plan as { services: unknown[] }).services).toHaveLength(2);
		expect(ref.rt.deploys.listApps()).toHaveLength(0);
	});

	it('creates one app per service plus a project group', async () => {
		const res = await importCompose(event({ compose: SIMPLE, agentId: 'agent-1' }) as never);
		const body = await json(res);
		expect(res.status).toBe(201);
		const apps = body.apps as { id: string; name: string }[];
		expect(apps.map((a) => a.name).sort()).toEqual(['shop-db', 'shop-web']);
		const stored = ref.rt.deploys.byName('shop-web')!;
		expect(stored.source).toEqual({ kind: 'image', url: 'ghcr.io/acme/web:1.2.3' });
		expect(stored.hasEnv).toBe(true);
		expect(stored.ports[0]).toEqual({ host: 8080, container: 80 });
		const group = (body.group as { name: string }).name;
		expect(group).toBe('shop');
		const members = getGroupStore(ref.db)
			.list()
			.find((g) => g.name === 'shop')!.members;
		expect(members).toHaveLength(2);
	});

	it('refuses the whole import when one service cannot convert', async () => {
		const res = await importCompose(
			event({
				compose: `services:\n  good:\n    image: img:1\n  bad:\n    build: ./dir\n`,
				agentId: 'agent-1'
			}) as never
		);
		expect(res.status).toBe(422);
		expect(ref.rt.deploys.byName('good')).toBeNull();
	});

	it('rejects a missing agent and missing yaml', async () => {
		expect((await importCompose(event({ compose: SIMPLE, agentId: 'nope' }) as never)).status).toBe(
			422
		);
		expect((await importCompose(event({ agentId: 'agent-1' }) as never)).status).toBe(422);
	});
});
