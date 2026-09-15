import type { DatabaseSync } from 'node:sqlite';
import { asDb, rawSqlite, type Db } from '../store/driver';
import type { Runtime } from '../runtime';
import { DAY_MS } from '../constants';

// Rolling-baseline anomaly detection. Each metric key keeps an
// exponentially weighted mean and variance; a new observation scores
// against the baseline built before it arrived, then folds in. This
// module owns its tables and creates them lazily so it can land
// without touching db.ts.

export const ANOMALY_MIN_SAMPLES = 30;
export const ANOMALY_ALERT_COOLDOWN_MS = 30 * 60_000;
export const ANOMALY_LIST_MAX = 500;

const ANOMALY_ALPHA = 0.1;
const ANOMALY_EPSILON = 0.01;
const ANOMALY_WARN_Z = 3;
const ANOMALY_ALERT_Z = 4;
const ANOMALY_DETAIL_MAX = 4096;
const ANOMALY_TICK_MS = 60_000;
const ANOMALY_RETENTION_DAYS = 30;

const METRIC_MAX = 128;
const METRIC_RE = /^[a-z0-9][a-z0-9._:-]{1,127}$/i;
const BASELINE_MAX = 2000;
const WINDOW_N_CAP = 240;
const FLAP_LOOKBACK_MS = 10 * 60_000;
const AGENT_SAMPLE_WINDOW_MS = 10 * 60_000;
const AGENT_SAMPLE_MAX = 500;
const HOUR_MS = 3600_000;

export const ANOMALY_SEVERITIES = ['info', 'warn', 'alert'] as const;
export type AnomalySeverity = (typeof ANOMALY_SEVERITIES)[number];

export interface AnomalyRow {
	id: number;
	metric: string;
	value: number;
	expected: number;
	z: number;
	severity: AnomalySeverity;
	detail: string | null;
	createdAt: number;
	ackedAt: number | null;
	ackedBy: string | null;
}

export interface BaselineRow {
	metric: string;
	n: number;
	windowN: number;
	mean: number;
	sd: number;
	updatedAt: number;
}

export interface AnomalySummary {
	openAlerts: number;
	warns24h: number;
	metricsTracked: number;
	lastAnomalyAt: number | null;
}

export interface Baseline {
	mean: number;
	variance: number;
	n: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS anomaly_baselines (
	metric     TEXT PRIMARY KEY,
	window_n   INTEGER NOT NULL,
	ewma       REAL NOT NULL,
	ewmvar     REAL NOT NULL,
	n          INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS anomalies (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	metric     TEXT NOT NULL,
	value      REAL NOT NULL,
	expected   REAL NOT NULL,
	z          REAL NOT NULL,
	severity   TEXT NOT NULL,
	detail     TEXT,
	created_at INTEGER NOT NULL,
	acked_at   INTEGER,
	acked_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_anomalies_created ON anomalies (created_at);
CREATE INDEX IF NOT EXISTS idx_anomalies_metric ON anomalies (metric, created_at);
`;

/** One EWMA step: fold value into the running mean and variance. */
export function ewmaUpdate(prev: Baseline | null, value: number, alpha = ANOMALY_ALPHA): Baseline {
	if (!prev || prev.n === 0) return { mean: value, variance: 0, n: 1 };
	const d = value - prev.mean;
	return {
		mean: prev.mean + alpha * d,
		variance: (1 - alpha) * (prev.variance + alpha * d * d),
		n: prev.n + 1
	};
}

/** Distance of value from the baseline in standard deviations. */
export function zScore(
	value: number,
	mean: number,
	variance: number,
	epsilon = ANOMALY_EPSILON
): number {
	return (value - mean) / Math.sqrt(variance + epsilon);
}

/**
 * Severity for a score, or null when the baseline is too young to
 * trust or the deviation is ordinary. Either tail counts: a metric
 * that flatlines is as anomalous as one that spikes.
 */
export function classify(
	z: number,
	n: number,
	minSamples = ANOMALY_MIN_SAMPLES
): AnomalySeverity | null {
	if (n < minSamples) return null;
	const a = Math.abs(z);
	if (a >= ANOMALY_ALERT_Z) return 'alert';
	if (a >= ANOMALY_WARN_Z) return 'warn';
	return null;
}

function boundedDetail(detail: Record<string, unknown>): string {
	return JSON.stringify(detail).slice(0, ANOMALY_DETAIL_MAX);
}

function fmtNum(v: number): string {
	if (!Number.isFinite(v)) return 'n/a';
	return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
}

function toRow(r: Record<string, unknown>): AnomalyRow {
	return {
		id: Number(r.id),
		metric: String(r.metric),
		value: Number(r.value),
		expected: Number(r.expected),
		z: Number(r.z),
		severity: r.severity as AnomalySeverity,
		detail: (r.detail as string | null) ?? null,
		createdAt: Number(r.created_at),
		ackedAt: r.acked_at === null ? null : Number(r.acked_at),
		ackedBy: (r.acked_by as string | null) ?? null
	};
}

// LIKE is not portable, so audit_log prefix scans run as range
// predicates and the finer patterns are filtered in memory. '.' is
// 0x2e, so the upper bound is the prefix with '.' bumped to '/'.
function prefixRange(prefix: string): [string, string] {
	return [prefix, prefix.slice(0, -1) + '/'];
}

export class AnomalyEngine {
	/** Wired by start(): receives alert-severity rows after cooldown. */
	alerter: ((a: AnomalyRow) => void) | null = null;

	private readonly db: Db;
	private readonly lastAlert = new Map<string, number>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private lastTick = 0;
	private lastPrune = 0;
	private baselineCount = -1;

	constructor(db: Db | DatabaseSync) {
		this.db = asDb(db);
		// Lazy DDL is sqlite-only; surreal gets these tables from
		// store/schema.ts.
		rawSqlite(this.db)?.exec(SCHEMA);
	}

	/**
	 * Record one observation. Returns the anomaly row when the value
	 * deviates beyond the warn threshold, else null. The baseline is
	 * updated either way so slow drift stays normal.
	 */
	async observe(
		metric: string,
		value: number,
		ts = Date.now(),
		detail?: Record<string, unknown>
	): Promise<AnomalyRow | null> {
		if (!METRIC_RE.test(metric) || !Number.isFinite(value)) return null;
		const prev = (await this.db
			.prepare('SELECT ewma, ewmvar, n FROM anomaly_baselines WHERE metric = ?')
			.get(metric)) as { ewma: number; ewmvar: number; n: number } | undefined;
		if (!prev && !(await this.admitBaseline())) return null;

		const expected = prev?.ewma ?? value;
		const z = prev ? zScore(value, expected, prev.ewmvar) : 0;
		const severity = classify(z, prev?.n ?? 0);

		const next = ewmaUpdate(
			prev ? { mean: prev.ewma, variance: prev.ewmvar, n: prev.n } : null,
			value
		);
		// metric is the record key, so the ON CONFLICT upsert is portable.
		await this.db
			.prepare(
				`INSERT INTO anomaly_baselines (metric, window_n, ewma, ewmvar, n, updated_at)
				VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT (metric) DO UPDATE SET
					window_n = excluded.window_n,
					ewma = excluded.ewma,
					ewmvar = excluded.ewmvar,
					n = excluded.n,
					updated_at = excluded.updated_at`
			)
			.run(metric, Math.min(next.n, WINDOW_N_CAP), next.mean, next.variance, next.n, ts);

		if (!severity) return null;
		const r = await this.db
			.prepare(
				`INSERT INTO anomalies (metric, value, expected, z, severity, detail, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.run(metric, value, expected, z, severity, detail ? boundedDetail(detail) : null, ts);
		const row: AnomalyRow = {
			id: Number(r.lastInsertRowid),
			metric,
			value,
			expected,
			z,
			severity,
			detail: detail ? boundedDetail(detail) : null,
			createdAt: ts,
			ackedAt: null,
			ackedBy: null
		};
		this.maybeAlert(row, ts);
		return row;
	}

	// A runaway source cannot mint unbounded metric keys: past the cap,
	// new names are dropped while existing ones keep updating.
	private async admitBaseline(): Promise<boolean> {
		if (this.baselineCount < 0) {
			this.baselineCount = (
				(await this.db.prepare('SELECT COUNT(*) AS n FROM anomaly_baselines').get()) as {
					n: number;
				}
			).n;
		}
		if (this.baselineCount >= BASELINE_MAX) return false;
		this.baselineCount += 1;
		return true;
	}

	private maybeAlert(a: AnomalyRow, now: number): void {
		if (a.severity !== 'alert' || !this.alerter) return;
		if (this.lastAlert.size > 1024) {
			for (const [k, t] of this.lastAlert) {
				if (now - t >= ANOMALY_ALERT_COOLDOWN_MS) this.lastAlert.delete(k);
			}
		}
		const last = this.lastAlert.get(a.metric);
		if (last !== undefined && now - last < ANOMALY_ALERT_COOLDOWN_MS) return;
		this.lastAlert.set(a.metric, now);
		try {
			this.alerter(a);
		} catch (err) {
			console.warn('[anomaly] alert hook failed:', err);
		}
	}

	async list(
		opts: {
			status?: 'open' | 'acked';
			since?: number;
			severity?: AnomalySeverity;
			metric?: string;
			limit?: number;
			cursor?: number;
		} = {}
	): Promise<{ entries: AnomalyRow[]; nextCursor: number | null }> {
		const limit = Math.min(Math.max(Math.floor(opts.limit ?? 100) || 100, 1), ANOMALY_LIST_MAX);
		const where: string[] = [];
		const args: (string | number)[] = [];
		if (opts.status === 'open') where.push('acked_at IS NULL');
		if (opts.status === 'acked') where.push('acked_at IS NOT NULL');
		if (opts.since !== undefined && Number.isFinite(opts.since)) {
			where.push('created_at >= ?');
			args.push(Math.floor(opts.since));
		}
		if (opts.severity && (ANOMALY_SEVERITIES as readonly string[]).includes(opts.severity)) {
			where.push('severity = ?');
			args.push(opts.severity);
		}
		if (opts.metric) {
			where.push('metric = ?');
			args.push(opts.metric.slice(0, METRIC_MAX));
		}
		if (opts.cursor && Number.isFinite(opts.cursor) && opts.cursor > 0) {
			where.push('id < ?');
			args.push(Math.floor(opts.cursor));
		}
		const rows = (await this.db
			.prepare(
				`SELECT id, metric, value, expected, z, severity, detail, created_at, acked_at, acked_by
				FROM anomalies ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
				ORDER BY id DESC LIMIT ?`
			)
			.all(...args, limit + 1)) as unknown as Record<string, unknown>[];
		const entries = rows.slice(0, limit).map(toRow);
		return {
			entries,
			nextCursor: rows.length > limit && entries.length > 0 ? entries[entries.length - 1].id : null
		};
	}

	/** Idempotent: returns the row whether this call acked it or a prior one did. */
	async ack(id: number, user: string, now = Date.now()): Promise<AnomalyRow | null> {
		if (!Number.isInteger(id) || id <= 0) return null;
		await this.db
			.prepare('UPDATE anomalies SET acked_at = ?, acked_by = ? WHERE id = ? AND acked_at IS NULL')
			.run(now, user.slice(0, 100), id);
		const row = await this.db
			.prepare(
				'SELECT id, metric, value, expected, z, severity, detail, created_at, acked_at, acked_by FROM anomalies WHERE id = ?'
			)
			.get(id);
		return row ? toRow(row) : null;
	}

	/**
	 * KPI numbers for the panel strip. CASE aggregates are not
	 * portable, so each count is its own bounded query.
	 */
	async summary(now = Date.now()): Promise<AnomalySummary> {
		const openAlerts = (
			(await this.db
				.prepare(
					"SELECT COUNT(*) AS n FROM anomalies WHERE severity = 'alert' AND acked_at IS NULL"
				)
				.get()) as { n: number }
		).n;
		const warns24h = (
			(await this.db
				.prepare("SELECT COUNT(*) AS n FROM anomalies WHERE severity = 'warn' AND created_at >= ?")
				.get(now - DAY_MS)) as { n: number }
		).n;
		const last = (await this.db
			.prepare('SELECT MAX(created_at) AS lastAnomalyAt FROM anomalies')
			.get()) as { lastAnomalyAt: number | null };
		const metricsTracked = (
			(await this.db.prepare('SELECT COUNT(*) AS n FROM anomaly_baselines').get()) as {
				n: number;
			}
		).n;
		return {
			openAlerts,
			warns24h,
			metricsTracked,
			lastAnomalyAt: last.lastAnomalyAt ?? null
		};
	}

	/** Every tracked metric with its baseline stats, for the panel filter. */
	async metrics(): Promise<BaselineRow[]> {
		const rows = (await this.db
			.prepare(
				'SELECT metric, n, window_n, ewma, ewmvar, updated_at FROM anomaly_baselines ORDER BY metric'
			)
			.all()) as unknown as {
			metric: string;
			n: number;
			window_n: number;
			ewma: number;
			ewmvar: number;
			updated_at: number;
		}[];
		return rows.map((r) => ({
			metric: r.metric,
			n: r.n,
			windowN: r.window_n,
			mean: r.ewma,
			sd: Math.sqrt(r.ewmvar),
			updatedAt: r.updated_at
		}));
	}

	/** Delete anomalies older than days. Returns rows removed. */
	async prune(days: number, now = Date.now()): Promise<number> {
		if (!Number.isFinite(days) || days <= 0) return 0;
		const r = await this.db
			.prepare('DELETE FROM anomalies WHERE created_at < ?')
			.run(now - days * DAY_MS);
		return Number(r.changes);
	}

	/**
	 * One collection pass over the source tables. Read-only queries,
	 * each bounded by a time window; a failing source does not stop
	 * the others.
	 */
	async collect(now = Date.now()): Promise<void> {
		const since = this.lastTick > 0 ? this.lastTick : now - ANOMALY_TICK_MS;
		this.lastTick = now;
		if (now - this.lastPrune >= HOUR_MS) {
			await this.prune(ANOMALY_RETENTION_DAYS, now);
			this.lastPrune = now;
		}
		for (const fn of [
			() => this.collectAuthFailures(since, now),
			() => this.collectRates(now),
			() => this.collectAgentDrift(now)
		]) {
			try {
				await fn();
			} catch (err) {
				console.warn('[anomaly] collector failed:', err);
			}
		}
	}

	// Failed or denied sign-ins in the last tick, matching the audit
	// summary's failedAuth definition plus lockouts. LIKE patterns are
	// not portable, so the auth.* prefix runs as a range scan and the
	// suffix patterns are filtered here.
	private async collectAuthFailures(since: number, now: number): Promise<void> {
		const [lo, hi] = prefixRange('auth.');
		const rows = (await this.db
			.prepare(
				'SELECT action FROM audit_log WHERE action >= ? AND action < ? AND at > ? AND at <= ?'
			)
			.all(lo, hi, since, now)) as unknown as { action: string }[];
		const n = rows.filter(
			(r) =>
				r.action.length > lo.length &&
				(r.action.endsWith('.fail') ||
					r.action.endsWith('.denied') ||
					r.action.endsWith('.disabled') ||
					r.action.includes('lockout'))
		).length;
		await this.observe('auth.failures_per_min', n, now);
	}

	private async collectRates(now: number): Promise<void> {
		const deploys = (
			(await this.db
				.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'deploy' AND created_at > ?")
				.get(now - HOUR_MS)) as { n: number }
		).n;
		await this.observe('deploy.per_hour', deploys, now);

		// checks.ok flips vs the previous check of the same service. The
		// lookback gives the in-memory comparison a row before the
		// window edge so a flap that started just outside still counts;
		// the LAG window function it replaces is not portable.
		const checkRows = (await this.db
			.prepare('SELECT service_id, ts, ok FROM checks WHERE ts > ? ORDER BY service_id, ts')
			.all(now - HOUR_MS - FLAP_LOOKBACK_MS)) as unknown as {
			service_id: string;
			ts: number;
			ok: number;
		}[];
		const prevOk = new Map<string, number>();
		let flaps = 0;
		for (const r of checkRows) {
			const prev = prevOk.get(r.service_id);
			if (r.ts > now - HOUR_MS && prev !== undefined && r.ok !== prev) flaps += 1;
			prevOk.set(r.service_id, r.ok);
		}
		await this.observe('service.flaps_per_hour', flaps, now);

		const [lo, hi] = prefixRange('config.');
		const churnRows = (await this.db
			.prepare('SELECT action FROM audit_log WHERE action >= ? AND action < ? AND at > ?')
			.all(lo, hi, now - HOUR_MS)) as unknown as { action: string }[];
		const churn = churnRows.filter((r) => r.action.length > lo.length).length;
		await this.observe('config.changes_per_hour', churn, now);
	}

	// Latest agent_samples row per agent, scored against that agent's
	// own baseline only. The ROW_NUMBER window is not portable, so
	// rows arrive ordered by agent and newest-first and the first row
	// per agent wins. ids come from the agents pipeline and are
	// validated again by the metric-name regex in observe().
	private async collectAgentDrift(now: number): Promise<void> {
		const rows = (await this.db
			.prepare(
				'SELECT agent_id, cpu, load1, ts FROM agent_samples WHERE ts > ? ORDER BY agent_id, ts DESC'
			)
			.all(now - AGENT_SAMPLE_WINDOW_MS)) as unknown as {
			agent_id: string;
			cpu: number | null;
			load1: number | null;
			ts: number;
		}[];
		const latest = new Map<string, { cpu: number | null; load1: number | null }>();
		for (const r of rows) {
			if (latest.size >= AGENT_SAMPLE_MAX && !latest.has(r.agent_id)) continue;
			if (!latest.has(r.agent_id)) latest.set(r.agent_id, { cpu: r.cpu, load1: r.load1 });
		}
		for (const [agentId, r] of latest) {
			if (r.cpu !== null) await this.observe(`agent.${agentId}.cpu`, r.cpu, now);
			if (r.load1 !== null) await this.observe(`agent.${agentId}.load1`, r.load1, now);
		}
	}

	/** Idempotent 60s tick for the runtime to start once. */
	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.collect().catch((err: unknown) => {
				console.error('[anomaly] tick failed:', err);
			});
		}, ANOMALY_TICK_MS);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}

const engines = new WeakMap<Db | DatabaseSync, AnomalyEngine>();

/** One engine per db handle; routes share the instance start() wired. */
export function getEngine(db: Db | DatabaseSync): AnomalyEngine {
	let e = engines.get(db);
	if (!e) {
		e = new AnomalyEngine(db);
		engines.set(db, e);
	}
	return e;
}

/**
 * Integrator entry point: call once from runtime wiring. Alert-severity
 * anomalies fan out through the notify dispatcher as incident events,
 * rate-limited per metric by the engine cooldown.
 */
export function start(rt: Runtime): AnomalyEngine {
	const engine = getEngine(rt.db);
	engine.alerter = (a) => {
		void rt.dispatcher
			.notify({
				event: 'incident',
				serviceName: `anomaly: ${a.metric}`,
				detail: `${a.metric} observed ${fmtNum(a.value)} vs baseline ${fmtNum(a.expected)} (z=${a.z.toFixed(1)})`
			})
			.catch((err: unknown) => {
				console.warn('[anomaly] notify failed:', err);
			});
	};
	engine.start();
	return engine;
}
