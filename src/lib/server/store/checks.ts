import type { DatabaseSync } from 'node:sqlite';
import type { CheckRow } from '$lib/shared/uptime';
import { asDb, type Db, type Stmt } from './driver';

export interface CheckResult {
	ok: boolean;
	latencyMs: number;
	status: 'up' | 'down' | 'degraded';
	detail?: string;
}

export class CheckStore {
	private readonly insert: Stmt;
	private readonly rangeQ: Stmt;
	private readonly latestQ: Stmt;
	private readonly uptimeQ: Stmt;
	private readonly pruneQ: Stmt;
	private readonly pruneIncidentsQ: Stmt;

	constructor(db: Db | DatabaseSync) {
		const d = asDb(db);
		this.insert = d.prepare(
			'INSERT INTO checks (service_id, ts, ok, latency, status, detail) VALUES (?, ?, ?, ?, ?, ?)'
		);
		this.rangeQ = d.prepare(
			'SELECT ts, ok, latency AS latencyMs FROM checks WHERE service_id = ? AND ts >= ? ORDER BY ts ASC'
		);
		this.latestQ = d.prepare(
			'SELECT ts, ok, latency AS latencyMs, status, detail FROM checks WHERE service_id = ? ORDER BY ts DESC LIMIT 1'
		);
		this.uptimeQ = d.prepare(
			'SELECT CAST(SUM(ok) AS REAL) / COUNT(*) AS frac FROM checks WHERE service_id = ? AND ts >= ?'
		);
		this.pruneQ = d.prepare('DELETE FROM checks WHERE ts < ?');
		this.pruneIncidentsQ = d.prepare(
			'DELETE FROM incidents WHERE ended_at IS NOT NULL AND ended_at < ?'
		);
	}

	async record(serviceId: string, r: CheckResult, ts = Date.now()): Promise<void> {
		await this.insert.run(
			serviceId,
			ts,
			r.ok ? 1 : 0,
			Math.round(r.latencyMs),
			r.status,
			r.detail ?? null
		);
	}

	/** Raw checks since `since` (unix ms), ascending. */
	async since(serviceId: string, since: number): Promise<CheckRow[]> {
		return (await this.rangeQ.all(serviceId, since)) as unknown as CheckRow[];
	}

	async latest(
		serviceId: string
	): Promise<(CheckRow & { status: string; detail: string | null }) | null> {
		const row = (await this.latestQ.get(serviceId)) as
			(CheckRow & { status: string; detail: string | null }) | undefined;
		return row ?? null;
	}

	/** Fraction of successful checks since `since`, null if no checks. */
	async uptimeFraction(serviceId: string, since: number): Promise<number | null> {
		const row = (await this.uptimeQ.get(serviceId, since)) as { frac: number | null } | undefined;
		return row?.frac ?? null;
	}

	/** Delete checks older than `before` (unix ms). Returns rows removed. */
	async prune(before: number): Promise<number> {
		return Number((await this.pruneQ.run(before)).changes);
	}

	async pruneIncidents(endedBefore: number): Promise<number> {
		return Number((await this.pruneIncidentsQ.run(endedBefore)).changes);
	}
}
