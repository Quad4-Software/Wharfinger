import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '$lib/server/store/db';
import { AgentStore } from '$lib/server/ingress/agents';
import { EdgeStore } from '$lib/server/ingress/edge';
import { EdgeReport } from '$lib/server/ingress/schema';

function freshDb(): DatabaseSync {
	return openDb(mkdtempSync(join(tmpdir(), 'wharfinger-edge-')));
}

function report(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		v: 1,
		ts: Date.now(),
		windowSec: 60,
		requests: 100,
		s2xx: 90,
		s3xx: 5,
		s4xx: 4,
		s5xx: 1,
		latencyP50: 12.3,
		latencyP95: 80.1,
		latencyP99: 140.5,
		clients: [{ ip: '203.0.113.7', requests: 42 }],
		paths: [{ path: '/api', requests: 60, errors: 1 }],
		errors: [
			{
				ts: Date.now(),
				method: 'GET',
				host: 'example.com',
				path: '/api',
				status: 500,
				ip: '1.2.3.4'
			}
		],
		...over
	};
}

describe('EdgeReport schema', () => {
	it('accepts a full report', () => {
		expect(v.safeParse(EdgeReport, report()).success).toBe(true);
	});

	it('accepts a minimal report', () => {
		const r = v.safeParse(EdgeReport, {
			v: 1,
			ts: Date.now(),
			windowSec: 60,
			requests: 1,
			s2xx: 1,
			s3xx: 0,
			s4xx: 0,
			s5xx: 0
		});
		expect(r.success).toBe(true);
	});

	it('rejects bad versions and out-of-range windows', () => {
		// v is a floor for forward compat, not an exact pin.
		expect(v.safeParse(EdgeReport, report({ v: 0 })).success).toBe(false);
		expect(v.safeParse(EdgeReport, report({ v: 2 })).success).toBe(true);
		expect(v.safeParse(EdgeReport, report({ windowSec: 0 })).success).toBe(false);
		expect(v.safeParse(EdgeReport, report({ windowSec: 7200 })).success).toBe(false);
	});

	it('rejects oversized collections', () => {
		expect(
			v.safeParse(
				EdgeReport,
				report({
					clients: Array.from({ length: 100 }, (_, i) => ({ ip: `10.0.0.${i}`, requests: 1 }))
				})
			).success
		).toBe(false);
	});
});

describe('EdgeStore', () => {
	function agentId(db: DatabaseSync): string {
		return new AgentStore(db).create('edge-1', null).id;
	}

	it('records, reads latest, and prunes', () => {
		const db = freshDb();
		const id = agentId(db);
		const store = new EdgeStore(db);
		store.record(id, v.parse(EdgeReport, report({ ts: Date.now() - 10 * 86_400_000 })));
		store.record(id, v.parse(EdgeReport, report()));
		const latest = store.latest(id);
		expect(latest?.requests).toBe(100);
		expect(latest?.clients?.[0].ip).toBe('203.0.113.7');
		expect(store.history(id, 0)).toHaveLength(2);

		store.prune(Date.now() - 5 * 86_400_000);
		expect(store.history(id, 0)).toHaveLength(1);
	});

	it('dedupes replays on (agent_id, ts)', () => {
		const db = freshDb();
		const id = agentId(db);
		const store = new EdgeStore(db);
		const r = v.parse(EdgeReport, report({ ts: Date.now() - 60_000 }));
		store.record(id, r);
		store.record(id, r); // plugin retry
		expect(store.history(id, 0)).toHaveLength(1);
	});

	it('returns null latest for unknown agents and corrupt rows', () => {
		const db = freshDb();
		const store = new EdgeStore(db);
		expect(store.latest('ag_none')).toBeNull();
		const id = agentId(db);
		db.prepare(
			'INSERT INTO edge_reports (agent_id, ts, window_s, requests, s2xx, s3xx, s4xx, s5xx, errs, report) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
		).run(id, Date.now(), 60, 0, 0, 0, 0, 0, 0, '{corrupt');
		expect(store.latest(id)).toBeNull();
	});

	it('buckets long history to a bounded point count', () => {
		const db = freshDb();
		const id = agentId(db);
		const store = new EdgeStore(db);
		const base = Date.now() - 1000 * 60_000;
		for (let i = 0; i < 1000; i++) {
			store.record(id, v.parse(EdgeReport, report({ ts: base + i * 60_000 })));
		}
		const samples = store.history(id, base);
		expect(samples.length).toBeLessThanOrEqual(600);
		expect(samples.length).toBeGreaterThan(400);
		// Bucket averages preserve the totals, not raw row counts.
		expect(samples.reduce((a, s) => a + s.requests, 0)).toBeGreaterThan(0);
	});
});
