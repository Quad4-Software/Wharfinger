import type { DatabaseSync } from 'node:sqlite';
import { asDb, type Db } from '$lib/server/store/driver';
import type { EdgeReport } from './schema';

export interface EdgeSample {
	ts: number;
	windowSec: number;
	requests: number;
	s2xx: number;
	s3xx: number;
	s4xx: number;
	s5xx: number;
	errs: number;
}

const MAX_HISTORY_POINTS = 600;

/** Edge traffic reports keyed to the registering system's agent id. */
export class EdgeStore {
	private readonly db: Db;

	constructor(db: Db | DatabaseSync) {
		this.db = asDb(db);
	}

	async record(agentId: string, r: EdgeReport): Promise<void> {
		const errs = r.errors?.length ?? 0;
		await this.db
			.prepare(
				'INSERT OR IGNORE INTO edge_reports (agent_id, ts, window_s, requests, s2xx, s3xx, s4xx, s5xx, errs, report) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
			)
			.run(
				agentId,
				r.ts,
				Math.round(r.windowSec),
				r.requests,
				r.s2xx,
				r.s3xx,
				r.s4xx,
				r.s5xx,
				errs,
				JSON.stringify(r)
			);
	}

	async latest(agentId: string): Promise<EdgeReport | null> {
		const row = (await this.db
			.prepare('SELECT report FROM edge_reports WHERE agent_id = ? ORDER BY ts DESC LIMIT 1')
			.get(agentId)) as { report: string } | undefined;
		if (!row) return null;
		try {
			return JSON.parse(row.report) as EdgeReport;
		} catch {
			return null;
		}
	}

	// Same bucketing approach as agent samples: group by time buckets
	// derived from the real data span, capped at MAX_HISTORY_POINTS.
	async history(agentId: string, sinceMs: number): Promise<EdgeSample[]> {
		const rows = (await this.db
			.prepare(
				'SELECT ts, window_s, requests, s2xx, s3xx, s4xx, s5xx, errs FROM edge_reports WHERE agent_id = ? AND ts >= ? ORDER BY ts ASC'
			)
			.all(agentId, sinceMs)) as unknown as {
			ts: number;
			window_s: number;
			requests: number;
			s2xx: number;
			s3xx: number;
			s4xx: number;
			s5xx: number;
			errs: number;
		}[];
		if (rows.length <= MAX_HISTORY_POINTS) {
			return rows.map((r) => ({
				ts: r.ts,
				windowSec: r.window_s,
				requests: r.requests,
				s2xx: r.s2xx,
				s3xx: r.s3xx,
				s4xx: r.s4xx,
				s5xx: r.s5xx,
				errs: r.errs
			}));
		}
		const span = rows[rows.length - 1].ts - rows[0].ts;
		const bucket = Math.max(1, Math.ceil(span / MAX_HISTORY_POINTS));
		const byBucket = new Map<number, typeof rows>();
		for (const r of rows) {
			const b = Math.min(Math.floor((r.ts - rows[0].ts) / bucket), MAX_HISTORY_POINTS - 1);
			const arr = byBucket.get(b) ?? [];
			arr.push(r);
			byBucket.set(b, arr);
		}
		const out: EdgeSample[] = [];
		for (const arr of byBucket.values()) {
			const n = arr.length;
			out.push({
				ts: Math.round(arr[n - 1].ts),
				windowSec: arr[n - 1].window_s,
				requests: Math.round(arr.reduce((a, r) => a + r.requests, 0) / n),
				s2xx: Math.round(arr.reduce((a, r) => a + r.s2xx, 0) / n),
				s3xx: Math.round(arr.reduce((a, r) => a + r.s3xx, 0) / n),
				s4xx: Math.round(arr.reduce((a, r) => a + r.s4xx, 0) / n),
				s5xx: Math.round(arr.reduce((a, r) => a + r.s5xx, 0) / n),
				errs: Math.round(arr.reduce((a, r) => a + r.errs, 0) / n)
			});
		}
		return out;
	}

	async prune(olderThanMs: number): Promise<void> {
		await this.db.prepare('DELETE FROM edge_reports WHERE ts < ?').run(olderThanMs);
	}
}
