import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { RequestEvent } from '@sveltejs/kit';
import type { Runtime } from '$lib/server/runtime';
import type { User } from '$lib/server/admin/users';
import type { Permission } from '$lib/server/admin/authz';
import { openDb } from '$lib/server/store/db';
import {
	ANOMALY_ALERT_COOLDOWN_MS,
	ANOMALY_MIN_SAMPLES,
	AnomalyEngine,
	classify,
	ewmaUpdate,
	getEngine,
	zScore,
	type AnomalyRow
} from '$lib/server/anomaly/engine';

function freshDb(): DatabaseSync {
	return openDb(mkdtempSync(join(tmpdir(), 'wharfinger-anomaly-')));
}

// Seed a settled baseline of constant v so the next point can be
// scored against enough history to clear the min-samples gate.
async function seedBaseline(
	e: AnomalyEngine,
	metric: string,
	v: number,
	n = ANOMALY_MIN_SAMPLES
): Promise<void> {
	for (let i = 0; i < n; i++) await e.observe(metric, v, 1_000_000 + i);
}

async function forceAlert(
	e: AnomalyEngine,
	metric = 'test.metric',
	ts = Date.now()
): Promise<AnomalyRow> {
	await seedBaseline(e, metric, 5);
	const a = await e.observe(metric, 5000, ts, { note: 'spike' });
	expect(a).not.toBeNull();
	return a!;
}

describe('ewmaUpdate', () => {
	it('converges the mean and decays variance on a constant series', () => {
		let b = ewmaUpdate(null, 10);
		expect(b).toEqual({ mean: 10, variance: 0, n: 1 });
		for (let i = 0; i < 50; i++) b = ewmaUpdate(b, 10);
		expect(b.mean).toBeCloseTo(10, 6);
		expect(b.variance).toBeCloseTo(0, 6);
	});

	it('tracks a shifted series and keeps positive variance on noise', () => {
		let b = ewmaUpdate(null, 0);
		for (let i = 0; i < 60; i++) b = ewmaUpdate(b, i % 2 === 0 ? 8 : 12);
		expect(b.mean).toBeGreaterThan(8);
		expect(b.mean).toBeLessThan(12);
		expect(b.variance).toBeGreaterThan(0);
	});
});

describe('zScore and classify', () => {
	it('scores distance in standard deviations', () => {
		expect(zScore(12, 10, 3)).toBeCloseTo(2 / Math.sqrt(3 + 0.01), 5);
		expect(zScore(10, 10, 0)).toBe(0);
	});

	it('classifies warn and alert at the z thresholds', () => {
		expect(classify(2.9, 100)).toBeNull();
		expect(classify(3, 100)).toBe('warn');
		expect(classify(3.9, 100)).toBe('warn');
		expect(classify(4, 100)).toBe('alert');
		expect(classify(-4.5, 100)).toBe('alert');
	});

	it('gates on min samples regardless of score', () => {
		expect(classify(50, ANOMALY_MIN_SAMPLES - 1)).toBeNull();
		expect(classify(50, ANOMALY_MIN_SAMPLES)).toBe('alert');
	});
});

describe('AnomalyEngine.observe', () => {
	it('stays quiet while the baseline is young, then flags a spike', async () => {
		const e = new AnomalyEngine(freshDb());
		for (let i = 0; i < ANOMALY_MIN_SAMPLES - 1; i++) {
			expect(await e.observe('m.young', 1000 * i, i)).toBeNull();
		}
		await seedBaseline(e, 'm.settled', 5);
		const a = await e.observe('m.settled', 5000);
		expect(a?.severity).toBe('alert');
		expect(a?.expected).toBeCloseTo(5, 0);
		expect(a?.detail).toBeNull();
	});

	it('rejects bad metric names and non-finite values', async () => {
		const e = new AnomalyEngine(freshDb());
		expect(await e.observe('bad name!', 1)).toBeNull();
		expect(await e.observe('x'.repeat(200), 1)).toBeNull();
		expect(await e.observe('ok.metric', Number.NaN)).toBeNull();
		expect(await e.observe('ok.metric', Number.POSITIVE_INFINITY)).toBeNull();
		expect(await e.metrics()).toHaveLength(0);
	});

	it('bounds detail JSON at 4KB', async () => {
		const e = new AnomalyEngine(freshDb());
		const a = await forceAlert(e, 'm.detail');
		const big = await e.observe('m.detail', 9000, Date.now() + 1, { pad: 'x'.repeat(10 * 1024) });
		expect(big?.detail?.length).toBeLessThanOrEqual(4096);
		expect(a.id).toBeGreaterThan(0);
	});
});

describe('AnomalyEngine.ack', () => {
	it('acks once, stays idempotent, and records the actor', async () => {
		const e = new AnomalyEngine(freshDb());
		const a = await forceAlert(e);
		const acked = await e.ack(a.id, 'alice');
		expect(acked?.ackedBy).toBe('alice');
		expect(acked?.ackedAt).toBeTypeOf('number');
		const again = await e.ack(a.id, 'bob');
		expect(again?.ackedBy).toBe('alice');
		expect(await e.ack(999999, 'alice')).toBeNull();
		expect(await e.ack(-1, 'alice')).toBeNull();
	});
});

describe('AnomalyEngine alert suppression', () => {
	it('rate-limits repeat alerts per metric for 30 minutes', async () => {
		const e = new AnomalyEngine(freshDb());
		const sent: AnomalyRow[] = [];
		e.alerter = (a) => sent.push(a);
		const t0 = 10_000_000;
		await forceAlert(e, 'm.sup', t0);
		await forceAlert(e, 'm.sup', t0 + 60_000);
		expect(sent).toHaveLength(1);
		await forceAlert(e, 'm.sup', t0 + ANOMALY_ALERT_COOLDOWN_MS + 1);
		expect(sent).toHaveLength(2);
	});

	it('does not notify on warn severity', async () => {
		const e = new AnomalyEngine(freshDb());
		const sent: AnomalyRow[] = [];
		e.alerter = (a) => sent.push(a);
		await seedBaseline(e, 'm.warn', 5);
		// Flat baseline: sd floors at sqrt(epsilon)=0.1, so 5.35 scores
		// z=3.5, warn but below the alert line the hook fires on.
		const w = await e.observe('m.warn', 5.35);
		expect(w?.severity).toBe('warn');
		expect(sent).toHaveLength(0);
	});
});

describe('AnomalyEngine.list and summary', () => {
	it('filters and paginates by cursor', async () => {
		const e = new AnomalyEngine(freshDb());
		for (let i = 0; i < 5; i++) await forceAlert(e, `m.${i}`, 5000 + i);
		const page1 = await e.list({ limit: 2 });
		expect(page1.entries).toHaveLength(2);
		expect(page1.nextCursor).not.toBeNull();
		const page2 = await e.list({ limit: 2, cursor: page1.nextCursor! });
		expect(page2.entries[0].id).toBeLessThan(page1.entries[1].id);
		expect((await e.list({ severity: 'warn' })).entries).toHaveLength(0);
		expect((await e.list({ metric: 'm.3' })).entries).toHaveLength(1);
		expect((await e.list({ status: 'open' })).entries).toHaveLength(5);
		const first = (await e.list({ limit: 1 })).entries[0];
		await e.ack(first.id, 'root');
		expect((await e.list({ status: 'acked' })).entries).toHaveLength(1);
		expect((await e.list({ status: 'open' })).entries).toHaveLength(4);
	});

	it('summarizes open alerts, recent warns, and tracked metrics', async () => {
		const e = new AnomalyEngine(freshDb());
		await forceAlert(e, 'm.s1');
		await forceAlert(e, 'm.s2');
		const s = await e.summary();
		expect(s.openAlerts).toBe(2);
		expect(s.metricsTracked).toBe(2);
		expect(s.lastAnomalyAt).toBeTypeOf('number');
	});
});

describe('AnomalyEngine collectors', () => {
	it('counts auth failures, deploys, flaps, config churn, and agent drift', async () => {
		const db = freshDb();
		const now = Date.now();
		// 3 auth failures inside the tick window, 1 outside it.
		const ins = db.prepare(
			'INSERT INTO audit_log (user_id, username, action, detail, ip, at) VALUES (NULL, NULL, ?, NULL, NULL, ?)'
		);
		for (let i = 0; i < 3; i++) ins.run('auth.login.fail', now - 10_000);
		ins.run('auth.login.fail', now - 120_000);
		ins.run('auth.login', now - 10_000);
		ins.run('config.section.save', now - 10_000);
		// 2 deploys enqueued this hour.
		const job = db.prepare(
			`INSERT INTO jobs (job_key, kind, target, status, spec, created_at, updated_at)
			VALUES (?, 'deploy', NULL, 'queued', '{}', ?, ?)`
		);
		job.run('d1', now - 600_000, now - 600_000);
		job.run('d2', now - 300_000, now - 300_000);
		// s1 flips up->down->up (2 transitions), s2 stays up.
		const chk = db.prepare(
			'INSERT INTO checks (service_id, ts, ok, latency, status, detail) VALUES (?, ?, ?, 10, ?, NULL)'
		);
		chk.run('s1', now - 50_000, 1, 'up');
		chk.run('s1', now - 40_000, 0, 'down');
		chk.run('s1', now - 30_000, 1, 'up');
		chk.run('s2', now - 40_000, 1, 'up');
		chk.run('s2', now - 30_000, 1, 'up');
		// Agent samples: latest row per agent feeds cpu + load1 metrics.
		const smp = db.prepare(
			`INSERT INTO agent_samples (agent_id, ts, cpu, mem_pct, disk_pct, rx_bps, tx_bps, load1, temp_max, mem_used, disk_used)
			VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL)`
		);
		smp.run('ag_t1', now - 20_000, 42, 1.5);
		smp.run('ag_t1', now - 120_000, 10, 0.5);

		const e = new AnomalyEngine(db);
		await e.collect(now);
		const stats = Object.fromEntries((await e.metrics()).map((m) => [m.metric, m]));
		expect(stats['auth.failures_per_min'].mean).toBe(3);
		expect(stats['deploy.per_hour'].mean).toBe(2);
		expect(stats['service.flaps_per_hour'].mean).toBe(2);
		expect(stats['config.changes_per_hour'].mean).toBe(1);
		expect(stats['agent.ag_t1.cpu'].mean).toBe(42);
		expect(stats['agent.ag_t1.load1'].mean).toBe(1.5);

		// Second tick: the stale audit row stays out of the window.
		await e.collect(now + 60_000);
		const after = Object.fromEntries((await e.metrics()).map((m) => [m.metric, m]));
		expect(after['auth.failures_per_min'].n).toBe(2);
	});

	it('is a no-op on empty source tables', async () => {
		const e = new AnomalyEngine(freshDb());
		await e.collect();
		expect((await e.metrics()).length).toBeGreaterThan(0);
	});
});

describe('AnomalyEngine lifecycle', () => {
	it('start is idempotent and stop clears the timer', () => {
		const e = new AnomalyEngine(freshDb());
		e.start();
		e.start();
		e.stop();
		e.stop();
	});

	it('getEngine returns one instance per db', () => {
		const db = freshDb();
		expect(getEngine(db)).toBe(getEngine(db));
	});

	it('prune drops old anomalies', async () => {
		const e = new AnomalyEngine(freshDb());
		await forceAlert(e, 'm.old', Date.now() - 40 * 86_400_000);
		await forceAlert(e, 'm.new');
		expect(await e.prune(30)).toBe(1);
		expect((await e.list()).entries).toHaveLength(1);
	});
});

// Route-level tests: auth rejection, validation rejection, happy path.
const ref = vi.hoisted(() => ({
	rt: undefined as unknown as Runtime,
	auditLog: [] as { action: string }[]
}));

vi.mock('$lib/server/runtime', () => ({
	getRuntime: () => ref.rt
}));

const { GET: listAnomalies } = await import('../../src/routes/admin/api/anomalies/+server');
const { GET: listMetrics } = await import('../../src/routes/admin/api/anomalies/metrics/+server');
const { POST: ackAnomaly } = await import('../../src/routes/admin/api/anomalies/[id]/ack/+server');

const viewer: User = {
	id: 1,
	username: 'root',
	displayName: '',
	role: 'admin',
	totpEnabled: false,
	createdAt: 0,
	disabledAt: null,
	lastLoginAt: null
};

function routeEvent(
	path: string,
	user: User | null,
	perms: string[] = ['anomaly.view'],
	params: Record<string, string> = {}
): RequestEvent {
	return {
		locals: {
			user,
			perms: user ? new Set(perms as Permission[]) : null,
			sessionHash: 'x',
			adminBase: '/admin'
		},
		params,
		url: new URL(`http://test${path}`),
		request: new Request(`http://test${path}`, { method: 'POST' }),
		getClientAddress: () => '127.0.0.1'
	} as unknown as RequestEvent;
}

async function statusOf(fn: (e: never) => unknown, ev: RequestEvent): Promise<number> {
	try {
		await fn(ev as never);
		return 200;
	} catch (e) {
		const s = (e as { status?: unknown }).status;
		return typeof s === 'number' ? s : 0;
	}
}

describe('anomaly api routes', () => {
	function setup(): AnomalyEngine {
		const db = freshDb();
		ref.rt = {
			db,
			audit: { log: (e: { action: string }) => ref.auditLog.push(e) },
			dispatcher: { notify: () => Promise.resolve() }
		} as unknown as Runtime;
		ref.auditLog.length = 0;
		return getEngine(db);
	}

	it('rejects anonymous callers with 401 and missing perms with 403', async () => {
		setup();
		const anon = routeEvent('/admin/api/anomalies', null);
		expect(await statusOf(listAnomalies, anon)).toBe(401);
		expect(await statusOf(listMetrics, anon)).toBe(401);
		const noperm = routeEvent('/admin/api/anomalies', viewer, ['audit.view']);
		expect(await statusOf(listAnomalies, noperm)).toBe(403);
		expect(await statusOf(listMetrics, noperm)).toBe(403);
		const ack = routeEvent('/admin/api/anomalies/1/ack', viewer, ['audit.view'], { id: '1' });
		expect(await statusOf(ackAnomaly, ack)).toBe(403);
	});

	it('lists anomalies with summary and honors hostile params safely', async () => {
		const e = setup();
		await forceAlert(e, 'm.route');
		const res = await listAnomalies(
			routeEvent('/admin/api/anomalies?severity=bogus&limit=99999&cursor=-4', viewer) as never
		);
		const body = (await res.json()) as {
			entries: { metric: string }[];
			summary: { openAlerts: number };
		};
		expect(body.entries.some((a) => a.metric === 'm.route')).toBe(true);
		expect(body.summary.openAlerts).toBeGreaterThan(0);
	});

	it('acks an anomaly, audits it, and 404s on unknown ids', async () => {
		const e = setup();
		const a = await forceAlert(e, 'm.ackme');
		const res = await ackAnomaly(
			routeEvent(`/admin/api/anomalies/${a.id}/ack`, viewer, ['anomaly.view'], {
				id: String(a.id)
			}) as never
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { anomaly: { ackedBy: string } };
		expect(body.anomaly.ackedBy).toBe('root');
		expect(ref.auditLog.some((l) => l.action === 'anomaly.ack')).toBe(true);

		const missing = await ackAnomaly(
			routeEvent('/admin/api/anomalies/424242/ack', viewer, ['anomaly.view'], {
				id: '424242'
			}) as never
		);
		expect(missing.status).toBe(404);
		const badId = await ackAnomaly(
			routeEvent('/admin/api/anomalies/abc/ack', viewer, ['anomaly.view'], { id: 'abc' }) as never
		);
		expect(badId.status).toBe(422);
	});
});
