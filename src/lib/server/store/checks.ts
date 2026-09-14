import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { CheckRow } from '$lib/shared/uptime';

export interface CheckResult {
	ok: boolean;
	latencyMs: number;
	status: 'up' | 'down' | 'degraded';
	detail?: string;
}

export class CheckStore {
	private readonly insert: StatementSync;
	private readonly rangeQ: StatementSync;
	private readonly latestQ: StatementSync;
	private readonly uptimeQ: StatementSync;
	private readonly pruneQ: StatementSync;
	private readonly pruneIncidentsQ: StatementSync;

	constructor(private readonly db: DatabaseSync) {
		this.insert = db.prepare(
			'INSERT INTO checks (service_id, ts, ok, latency, status, detail) VALUES (?, ?, ?, ?, ?, ?)'
		);
		this.rangeQ = db.prepare(
			'SELECT ts, ok, latency AS latencyMs FROM checks WHERE service_id = ? AND ts >= ? ORDER BY ts ASC'
		);
		this.latestQ = db.prepare(
			'SELECT ts, ok, latency AS latencyMs, status, detail FROM checks WHERE service_id = ? ORDER BY ts DESC LIMIT 1'
		);
		this.uptimeQ = db.prepare(
			'SELECT CAST(SUM(ok) AS REAL) / COUNT(*) AS frac FROM checks WHERE service_id = ? AND ts >= ?'
		);
		this.pruneQ = db.prepare('DELETE FROM checks WHERE ts < ?');
		this.pruneIncidentsQ = db.prepare(
			'DELETE FROM incidents WHERE ended_at IS NOT NULL AND ended_at < ?'
		);
	}

	record(serviceId: string, r: CheckResult, ts = Date.now()): void {
		this.insert.run(
			serviceId,
			ts,
			r.ok ? 1 : 0,
			Math.round(r.latencyMs),
			r.status,
			r.detail ?? null
		);
	}

	/** Raw checks since `since` (unix ms), ascending. */
	since(serviceId: string, since: number): CheckRow[] {
		return this.rangeQ.all(serviceId, since) as unknown as CheckRow[];
	}

	latest(serviceId: string): (CheckRow & { status: string; detail: string | null }) | null {
		const row = this.latestQ.get(serviceId) as
			(CheckRow & { status: string; detail: string | null }) | undefined;
		return row ?? null;
	}

	/** Fraction of successful checks since `since`, null if no checks. */
	uptimeFraction(serviceId: string, since: number): number | null {
		const row = this.uptimeQ.get(serviceId, since) as { frac: number | null } | undefined;
		return row?.frac ?? null;
	}

	/** Delete checks older than `before` (unix ms). Returns rows removed. */
	prune(before: number): number {
		return Number(this.pruneQ.run(before).changes);
	}

	pruneIncidents(endedBefore: number): number {
		return Number(this.pruneIncidentsQ.run(endedBefore).changes);
	}
}
