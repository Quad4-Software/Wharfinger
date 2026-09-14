import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { openDb } from '$lib/server/store/db';
import { TelemetryStore } from '$lib/server/telemetry/store';
import { itemFromEnvelope, normalizeTransaction } from '$lib/server/telemetry/ingest';

const TRACE_ID = 'abcdef0123456789abcdef0123456789';
const ROOT_SPAN = '0123456789abcdef';

function tx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: 'transaction',
		transaction: 'GET /api/users',
		start_timestamp: 1700000000,
		timestamp: 1700000000.5,
		release: '1.2.3',
		environment: 'prod',
		contexts: {
			trace: { trace_id: TRACE_ID, span_id: ROOT_SPAN, op: 'http.server', status: 'ok' }
		},
		spans: [
			{
				trace_id: TRACE_ID,
				span_id: 'aaaa000000000001',
				parent_span_id: ROOT_SPAN,
				op: 'db',
				description: 'SELECT * FROM users',
				start_timestamp: 1700000000.1,
				timestamp: 1700000000.3,
				status: 'ok'
			},
			{
				trace_id: TRACE_ID,
				span_id: 'aaaa000000000002',
				parent_span_id: ROOT_SPAN,
				op: 'http.client',
				description: 'GET https://upsteam',
				start_timestamp: 1700000000.3,
				timestamp: 1700000000.45,
				data: { url: 'https://upsteam', token: 'secret-value' },
				tags: { region: 'us' }
			}
		],
		...overrides
	};
}

function store() {
	return new TelemetryStore(openDb(mkdtempSync(join(tmpdir(), 'wharfinger-tr-'))));
}

function recordTx(ts: TelemetryStore, projectId: number, raw = tx()) {
	const t = normalizeTransaction(raw);
	if (!t) throw new Error('normalizeTransaction returned null');
	ts.recordTrace({ projectId, ...t });
	return t;
}

describe('ingest: normalizeTransaction', () => {
	it('parses a sentry-shaped transaction', () => {
		const t = normalizeTransaction(tx());
		expect(t).not.toBeNull();
		expect(t!.traceId).toBe(TRACE_ID);
		expect(t!.spanId).toBe(ROOT_SPAN);
		expect(t!.name).toBe('GET /api/users');
		expect(t!.op).toBe('http.server');
		expect(t!.status).toBe('ok');
		expect(t!.ts).toBe(1700000000000);
		expect(t!.durationMs).toBe(500);
		expect(t!.release).toBe('1.2.3');
		expect(t!.spans).toHaveLength(2);
		expect(t!.spans[0].parentSpanId).toBe(ROOT_SPAN);
		expect(t!.spans[0].endMs - t!.spans[0].startMs).toBe(200);
	});

	it('rejects missing or invalid trace ids', () => {
		expect(normalizeTransaction({ transaction: 'x' })).toBeNull();
		expect(
			normalizeTransaction(tx({ contexts: { trace: { trace_id: 'not-hex', span_id: ROOT_SPAN } } }))
		).toBeNull();
	});

	it('caps name, op, and description lengths', () => {
		const t = normalizeTransaction(
			tx({
				transaction: 'n'.repeat(500),
				contexts: { trace: { trace_id: TRACE_ID, span_id: ROOT_SPAN, op: 'o'.repeat(200) } },
				spans: [
					{
						span_id: 'aaaa000000000001',
						parent_span_id: ROOT_SPAN,
						description: 'd'.repeat(1000),
						start_timestamp: 1,
						timestamp: 2
					}
				]
			})
		);
		expect(t!.name).toHaveLength(256);
		expect(t!.op).toHaveLength(64);
		expect(t!.spans[0].description).toHaveLength(512);
	});

	it('caps the span count and drops malformed span rows', () => {
		const spans = [
			{ span_id: 'bad!!', start_timestamp: 1, timestamp: 2 },
			...Array.from({ length: 600 }, (_, i) => ({
				span_id: String(i).padStart(16, '0'),
				parent_span_id: ROOT_SPAN,
				start_timestamp: 1700000000,
				timestamp: 1700000000.01
			}))
		];
		const t = normalizeTransaction(tx({ spans }));
		// 601 raw rows: cap keeps the first 500, then the bad id drops.
		expect(t!.spans).toHaveLength(499);
		expect(t!.spans.every((s) => /^[a-f0-9]{16}$/.test(s.spanId))).toBe(true);
	});

	it('scrubs secrets out of span data and tags', () => {
		const t = normalizeTransaction(tx());
		const dbSpan = t!.spans.find((s) => s.op === 'http.client')!;
		expect(dbSpan.data).not.toBeNull();
		expect(dbSpan.data).not.toContain('secret-value');
		expect(dbSpan.data).toContain('[Filtered]');
		expect(dbSpan.data).toContain('"region":"us"');
	});

	it('clamps future timestamps and floors duration at zero', () => {
		const t = normalizeTransaction(
			tx({ start_timestamp: Date.now() / 1000 + 99999, timestamp: 1700000000 })
		);
		expect(t!.ts).toBeLessThanOrEqual(Date.now() + 61_000);
		expect(t!.durationMs).toBe(0);
	});

	it('orders spans by start time', () => {
		const t = normalizeTransaction(tx());
		expect(t!.spans[0].startMs).toBeLessThanOrEqual(t!.spans[1].startMs);
	});
});

describe('ingest: envelope dispatch', () => {
	function env(items: string[]): Uint8Array {
		return new TextEncoder().encode(items.join('\n'));
	}
	it('classifies transaction items separately from events', () => {
		const payload = JSON.stringify(tx());
		const i = itemFromEnvelope(
			env(['{}', `{"type":"transaction","length":${payload.length}}`, payload])
		);
		expect(i?.kind).toBe('transaction');
	});
	it('a transaction-only envelope yields no event', () => {
		const payload = JSON.stringify(tx());
		const i = itemFromEnvelope(env(['{}', '{"type":"transaction"}', payload]));
		expect(i?.kind).not.toBe('event');
	});
});

describe('TelemetryStore traces', () => {
	let ts: TelemetryStore;
	beforeEach(() => {
		ts = store();
	});

	it('round-trips a trace with ordered spans', () => {
		const p = ts.createProject('app');
		recordTx(ts, p.id);
		const r = ts.trace(p.id, TRACE_ID);
		expect(r).not.toBeNull();
		expect(r!.trace.name).toBe('GET /api/users');
		expect(r!.trace.durationMs).toBe(500);
		expect(r!.trace.spanCount).toBe(2);
		expect(r!.spans).toHaveLength(2);
		expect(r!.spans[0].startMs).toBeLessThanOrEqual(r!.spans[1].startMs);
		expect(r!.spans[0].description).toBe('SELECT * FROM users');
	});

	it('a recorded trace never creates an issue', () => {
		const p = ts.createProject('app');
		recordTx(ts, p.id);
		expect(ts.issues(p.id, { limit: 10 }).total).toBe(0);
		expect(ts.traces(p.id, { limit: 10 }).total).toBe(1);
	});

	it('lists traces paginated and filters by name', () => {
		const p = ts.createProject('app');
		for (let i = 0; i < 5; i++) {
			recordTx(
				ts,
				p.id,
				tx({ transaction: i < 3 ? 'GET /a' : 'POST /b', start_timestamp: 1700000000 + i })
			);
		}
		const all = ts.traces(p.id, { limit: 2 });
		expect(all.total).toBe(5);
		expect(all.entries).toHaveLength(2);
		expect(ts.traces(p.id, { limit: 50, name: 'POST /b' }).total).toBe(2);
		expect(ts.traces(p.id, { limit: 50, q: 'post' }).total).toBe(2);
	});

	it('computes per-name stats with percentiles', () => {
		const p = ts.createProject('app');
		for (let i = 1; i <= 10; i++) {
			recordTx(ts, p.id, tx({ start_timestamp: 1700000000, timestamp: 1700000000 + i / 10 }));
		}
		recordTx(ts, p.id, tx({ transaction: 'other', timestamp: 1700000000.2 }));
		const stats = ts.transactionStats(p.id);
		const main = stats.find((s) => s.name === 'GET /api/users')!;
		expect(main.count).toBe(10);
		expect(main.avg).toBe(550);
		expect(main.p50).toBe(500);
		expect(main.p95).toBe(1000);
		expect(main.p99).toBe(1000);
		expect(stats.find((s) => s.name === 'other')!.count).toBe(1);
	});

	it('prune keeps traces bounded and spans consistent', () => {
		const db = openDb(mkdtempSync(join(tmpdir(), 'wharfinger-tr-')));
		const s = new TelemetryStore(db);
		const p = s.createProject('app');
		const insT = db.prepare(
			`INSERT INTO telemetry_traces
			(project_id, trace_id, span_id, name, op, ts, duration_ms, span_count, status, release, environment)
			VALUES (?, ?, ?, 'n', NULL, ?, 10, 1, NULL, NULL, NULL)`
		);
		const insS = db.prepare(
			'INSERT INTO telemetry_spans (trace_row_id, span_id, parent_span_id, op, description, start_ms, end_ms, status, data) VALUES (?, ?, NULL, NULL, NULL, 0, 1, NULL, NULL)'
		);
		db.exec('BEGIN');
		for (let i = 0; i < 2100; i++) {
			const r = insT.run(p.id, `t${String(i).padStart(31, '0')}`, 'a'.repeat(16), i);
			insS.run(Number(r.lastInsertRowid), 'a'.repeat(16));
		}
		db.exec('COMMIT');
		s.prune();
		const traces = (db.prepare('SELECT COUNT(*) AS n FROM telemetry_traces').get() as { n: number })
			.n;
		const spans = (db.prepare('SELECT COUNT(*) AS n FROM telemetry_spans').get() as { n: number })
			.n;
		expect(traces).toBe(2000);
		expect(spans).toBe(2000);
		db.close();
	});

	it('deleting a project removes traces and spans', () => {
		const p = ts.createProject('app');
		recordTx(ts, p.id);
		ts.deleteProject(p.id);
		expect(ts.traces(p.id, { limit: 10 }).total).toBe(0);
		expect(ts.trace(p.id, TRACE_ID)).toBeNull();
	});
});
