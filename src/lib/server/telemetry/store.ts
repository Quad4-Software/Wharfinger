import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// Local error-tracking store: the hub's Bugsink/GlitchTip side.
// Projects own a public DSN key; events group into issues by
// fingerprint. Bounds everywhere so a noisy app cannot grow the db.

const TELEMETRY_MAX_EVENTS_PER_PROJECT = 5000;
const TELEMETRY_MAX_EVENTS_TOTAL = 100_000;
const TELEMETRY_MAX_TRACES_PER_PROJECT = 2000;
const TELEMETRY_MAX_TRACES_TOTAL = 20_000;
const STATS_WINDOW = 5000;

export interface TelemetryProject {
	id: number;
	name: string;
	publicKey: string;
	platform: string | null;
	createdAt: number;
	disabledAt: number | null;
}

export interface TelemetryIssue {
	projectId: number;
	fingerprint: string;
	title: string;
	culprit: string | null;
	level: string;
	firstSeen: number;
	lastSeen: number;
	count: number;
	resolvedAt: number | null;
}

export interface TelemetryEventRow {
	id: number;
	projectId: number;
	issueFp: string;
	eventId: string | null;
	ts: number;
	level: string;
	platform: string | null;
	message: string | null;
	excType: string | null;
	excValue: string | null;
	release: string | null;
	environment: string | null;
	tags: string;
	request: string | null;
	stack: string | null;
	raw: string;
}

export interface TelemetryTrace {
	id: number;
	projectId: number;
	traceId: string;
	spanId: string | null;
	name: string;
	op: string | null;
	ts: number;
	durationMs: number;
	spanCount: number;
	status: string | null;
	release: string | null;
	environment: string | null;
}

export interface TelemetrySpan {
	spanId: string;
	parentSpanId: string | null;
	op: string | null;
	description: string | null;
	startMs: number;
	endMs: number;
	status: string | null;
	data: string | null;
}

export interface TransactionStat {
	name: string;
	count: number;
	avg: number;
	p50: number;
	p95: number;
	p99: number;
	lastSeen: number;
}

interface StoredTrace {
	projectId: number;
	traceId: string;
	spanId: string | null;
	name: string;
	op: string | null;
	ts: number;
	durationMs: number;
	status: string | null;
	release: string | null;
	environment: string | null;
	spans: TelemetrySpan[];
}

interface StoredEvent {
	projectId: number;
	fingerprint: string;
	title: string;
	culprit: string | null;
	level: string;
	eventId: string | null;
	ts: number;
	platform: string | null;
	message: string | null;
	excType: string | null;
	excValue: string | null;
	release: string | null;
	environment: string | null;
	tags: string;
	request: string | null;
	stack: string | null;
	raw: string;
}

export class TelemetryStore {
	constructor(private readonly db: DatabaseSync) {}

	createProject(name: string, platform?: string | null): TelemetryProject {
		const key = randomBytes(16).toString('hex');
		const r = this.db
			.prepare(
				'INSERT INTO telemetry_projects (name, public_key, platform, created_at) VALUES (?, ?, ?, ?)'
			)
			.run(name, key, platform ?? null, Date.now());
		const p = this.project(Number(r.lastInsertRowid));
		if (!p) throw new Error('telemetry project insert failed');
		return p;
	}

	project(id: number): TelemetryProject | null {
		const r = this.db
			.prepare(
				'SELECT id, name, public_key AS publicKey, platform, created_at AS createdAt, disabled_at AS disabledAt FROM telemetry_projects WHERE id = ?'
			)
			.get(id) as TelemetryProject | undefined;
		return r ?? null;
	}

	projectByKey(key: string): TelemetryProject | null {
		const r = this.db
			.prepare(
				'SELECT id, name, public_key AS publicKey, platform, created_at AS createdAt, disabled_at AS disabledAt FROM telemetry_projects WHERE public_key = ?'
			)
			.get(key) as TelemetryProject | undefined;
		return r ?? null;
	}

	projects(): TelemetryProject[] {
		return this.db
			.prepare(
				'SELECT id, name, public_key AS publicKey, platform, created_at AS createdAt, disabled_at AS disabledAt FROM telemetry_projects ORDER BY id'
			)
			.all() as unknown as TelemetryProject[];
	}

	setProjectDisabled(id: number, disabled: boolean): void {
		this.db
			.prepare('UPDATE telemetry_projects SET disabled_at = ? WHERE id = ?')
			.run(disabled ? Date.now() : null, id);
	}

	deleteProject(id: number): void {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			this.db.prepare('DELETE FROM telemetry_events WHERE project_id = ?').run(id);
			this.db.prepare('DELETE FROM telemetry_issues WHERE project_id = ?').run(id);
			this.db
				.prepare(
					'DELETE FROM telemetry_spans WHERE trace_row_id IN (SELECT id FROM telemetry_traces WHERE project_id = ?)'
				)
				.run(id);
			this.db.prepare('DELETE FROM telemetry_traces WHERE project_id = ?').run(id);
			this.db.prepare('DELETE FROM telemetry_projects WHERE id = ?').run(id);
			this.db.exec('COMMIT');
		} catch (err) {
			this.db.exec('ROLLBACK');
			throw err;
		}
	}

	/**
	 * Store one parsed event and upsert its issue in one transaction.
	 * A resolved issue that recurs reopens automatically (count keeps
	 * climbing, resolved_at clears).
	 */
	record(e: StoredEvent): void {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			this.db
				.prepare(
					`INSERT INTO telemetry_events
					(project_id, issue_fp, event_id, ts, level, platform, message, exc_type, exc_value, release, environment, tags, request, stack, raw)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					e.projectId,
					e.fingerprint,
					e.eventId,
					e.ts,
					e.level,
					e.platform,
					e.message,
					e.excType,
					e.excValue,
					e.release,
					e.environment,
					e.tags,
					e.request,
					e.stack,
					e.raw
				);
			this.db
				.prepare(
					`INSERT INTO telemetry_issues (project_id, fingerprint, title, culprit, level, first_seen, last_seen, count, resolved_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL)
					ON CONFLICT (project_id, fingerprint) DO UPDATE SET
						last_seen = excluded.last_seen,
						count = count + 1,
						level = excluded.level,
						title = excluded.title,
						culprit = excluded.culprit,
						resolved_at = NULL`
				)
				.run(e.projectId, e.fingerprint, e.title, e.culprit, e.level, e.ts, e.ts);
			this.db.exec('COMMIT');
		} catch (err) {
			this.db.exec('ROLLBACK');
			throw err;
		}
	}

	issues(
		projectId: number | null,
		opts: { limit: number; offset?: number; unresolved?: boolean; q?: string }
	): { entries: TelemetryIssue[]; total: number } {
		const where: string[] = [];
		const args: (string | number)[] = [];
		if (projectId !== null) {
			where.push('project_id = ?');
			args.push(projectId);
		}
		if (opts.unresolved) where.push('resolved_at IS NULL');
		if (opts.q) {
			const like = `%${opts.q.replaceAll('%', '').replaceAll('_', '')}%`;
			where.push('(title LIKE ? OR culprit LIKE ?)');
			args.push(like, like);
		}
		const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
		const total = (
			this.db.prepare(`SELECT COUNT(*) AS n FROM telemetry_issues ${w}`).get(...args) as {
				n: number;
			}
		).n;
		const entries = this.db
			.prepare(
				`SELECT project_id AS projectId, fingerprint, title, culprit, level, first_seen AS firstSeen, last_seen AS lastSeen, count, resolved_at AS resolvedAt
				FROM telemetry_issues ${w} ORDER BY last_seen DESC LIMIT ? OFFSET ?`
			)
			.all(...args, opts.limit, opts.offset ?? 0) as unknown as TelemetryIssue[];
		return { entries, total };
	}

	issue(projectId: number, fingerprint: string): TelemetryIssue | null {
		const r = this.db
			.prepare(
				`SELECT project_id AS projectId, fingerprint, title, culprit, level, first_seen AS firstSeen, last_seen AS lastSeen, count, resolved_at AS resolvedAt
				FROM telemetry_issues WHERE project_id = ? AND fingerprint = ?`
			)
			.get(projectId, fingerprint) as TelemetryIssue | undefined;
		return r ?? null;
	}

	setIssueResolved(projectId: number, fingerprint: string, resolved: boolean): void {
		this.db
			.prepare(
				'UPDATE telemetry_issues SET resolved_at = ? WHERE project_id = ? AND fingerprint = ?'
			)
			.run(resolved ? Date.now() : null, projectId, fingerprint);
	}

	events(
		projectId: number,
		fingerprint: string,
		opts: { limit: number; offset?: number }
	): { entries: TelemetryEventRow[]; total: number } {
		const total = (
			this.db
				.prepare('SELECT COUNT(*) AS n FROM telemetry_events WHERE project_id = ? AND issue_fp = ?')
				.get(projectId, fingerprint) as { n: number }
		).n;
		const entries = this.db
			.prepare(
				`SELECT id, project_id AS projectId, issue_fp AS issueFp, event_id AS eventId, ts, level, platform, message, exc_type AS excType, exc_value AS excValue, release, environment, tags, request, stack, raw
				FROM telemetry_events WHERE project_id = ? AND issue_fp = ? ORDER BY ts DESC LIMIT ? OFFSET ?`
			)
			.all(projectId, fingerprint, opts.limit, opts.offset ?? 0) as unknown as TelemetryEventRow[];
		return { entries, total };
	}

	eventById(id: number): TelemetryEventRow | null {
		const r = this.db
			.prepare(
				`SELECT id, project_id AS projectId, issue_fp AS issueFp, event_id AS eventId, ts, level, platform, message, exc_type AS excType, exc_value AS excValue, release, environment, tags, request, stack, raw
				FROM telemetry_events WHERE id = ?`
			)
			.get(id) as TelemetryEventRow | undefined;
		return r ?? null;
	}

	/** Store one transaction and its spans in a single transaction. */
	recordTrace(t: StoredTrace): void {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			const r = this.db
				.prepare(
					`INSERT INTO telemetry_traces
					(project_id, trace_id, span_id, name, op, ts, duration_ms, span_count, status, release, environment)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					t.projectId,
					t.traceId,
					t.spanId,
					t.name,
					t.op,
					t.ts,
					t.durationMs,
					t.spans.length,
					t.status,
					t.release,
					t.environment
				);
			const rowId = Number(r.lastInsertRowid);
			const ins = this.db.prepare(
				`INSERT INTO telemetry_spans
				(trace_row_id, span_id, parent_span_id, op, description, start_ms, end_ms, status, data)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			);
			for (const s of t.spans) {
				ins.run(
					rowId,
					s.spanId,
					s.parentSpanId,
					s.op,
					s.description,
					s.startMs,
					s.endMs,
					s.status,
					s.data
				);
			}
			this.db.exec('COMMIT');
		} catch (err) {
			this.db.exec('ROLLBACK');
			throw err;
		}
	}

	traces(
		projectId: number,
		opts: { limit: number; offset?: number; q?: string; name?: string }
	): { entries: TelemetryTrace[]; total: number } {
		const where = ['project_id = ?'];
		const args: (string | number)[] = [projectId];
		if (opts.name) {
			where.push('name = ?');
			args.push(opts.name);
		}
		if (opts.q) {
			const like = `%${opts.q.replaceAll('%', '').replaceAll('_', '')}%`;
			where.push('(name LIKE ? OR trace_id LIKE ?)');
			args.push(like, like);
		}
		const w = `WHERE ${where.join(' AND ')}`;
		const total = (
			this.db.prepare(`SELECT COUNT(*) AS n FROM telemetry_traces ${w}`).get(...args) as {
				n: number;
			}
		).n;
		const entries = this.db
			.prepare(
				`SELECT id, project_id AS projectId, trace_id AS traceId, span_id AS spanId, name, op, ts, duration_ms AS durationMs, span_count AS spanCount, status, release, environment
				FROM telemetry_traces ${w} ORDER BY ts DESC LIMIT ? OFFSET ?`
			)
			.all(...args, opts.limit, opts.offset ?? 0) as unknown as TelemetryTrace[];
		return { entries, total };
	}

	/** Newest trace row for a Sentry trace_id plus its ordered spans. */
	trace(
		projectId: number,
		traceId: string
	): { trace: TelemetryTrace; spans: TelemetrySpan[] } | null {
		const t = this.db
			.prepare(
				`SELECT id, project_id AS projectId, trace_id AS traceId, span_id AS spanId, name, op, ts, duration_ms AS durationMs, span_count AS spanCount, status, release, environment
				FROM telemetry_traces WHERE project_id = ? AND trace_id = ? ORDER BY ts DESC LIMIT 1`
			)
			.get(projectId, traceId) as TelemetryTrace | undefined;
		if (!t) return null;
		const spans = this.db
			.prepare(
				`SELECT span_id AS spanId, parent_span_id AS parentSpanId, op, description, start_ms AS startMs, end_ms AS endMs, status, data
				FROM telemetry_spans WHERE trace_row_id = ? ORDER BY start_ms`
			)
			.all(t.id) as unknown as TelemetrySpan[];
		return { trace: t, spans };
	}

	/** Per-transaction-name latency stats over the most recent rows. */
	transactionStats(projectId: number): TransactionStat[] {
		const rows = this.db
			.prepare(
				`SELECT name, duration_ms AS d, ts FROM telemetry_traces
				WHERE project_id = ? ORDER BY ts DESC LIMIT ${STATS_WINDOW}`
			)
			.all(projectId) as { name: string; d: number; ts: number }[];
		const byName = new Map<string, { durs: number[]; lastSeen: number }>();
		for (const r of rows) {
			let g = byName.get(r.name);
			if (!g) {
				g = { durs: [], lastSeen: r.ts };
				byName.set(r.name, g);
			}
			g.durs.push(r.d);
			if (r.ts > g.lastSeen) g.lastSeen = r.ts;
		}
		return [...byName.entries()]
			.map(([name, g]) => {
				const s = [...g.durs].sort((a, b) => a - b);
				const sum = s.reduce((a, b) => a + b, 0);
				return {
					name,
					count: s.length,
					avg: sum / s.length,
					p50: percentile(s, 0.5),
					p95: percentile(s, 0.95),
					p99: percentile(s, 0.99),
					lastSeen: g.lastSeen
				};
			})
			.sort((a, b) => b.count - a.count);
	}

	/** Per-project and global caps; cheap row-count maintenance. */
	prune(): void {
		this.db.exec(
			`DELETE FROM telemetry_events WHERE id IN (
				SELECT id FROM (
					SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY ts DESC) AS rn
					FROM telemetry_events
				) WHERE rn > ${TELEMETRY_MAX_EVENTS_PER_PROJECT}
			)`
		);
		this.db.exec(
			`DELETE FROM telemetry_events WHERE id NOT IN (
				SELECT id FROM telemetry_events ORDER BY ts DESC LIMIT ${TELEMETRY_MAX_EVENTS_TOTAL}
			)`
		);
		// Span rows must go with their trace; one transaction keeps the
		// waterfall consistent even if the prune is interrupted.
		this.db.exec('BEGIN IMMEDIATE');
		try {
			this.db.exec(
				`DELETE FROM telemetry_spans WHERE trace_row_id IN (
					SELECT id FROM (
						SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY ts DESC) AS rn
						FROM telemetry_traces
					) WHERE rn > ${TELEMETRY_MAX_TRACES_PER_PROJECT}
				)`
			);
			this.db.exec(
				`DELETE FROM telemetry_traces WHERE id IN (
					SELECT id FROM (
						SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY ts DESC) AS rn
						FROM telemetry_traces
					) WHERE rn > ${TELEMETRY_MAX_TRACES_PER_PROJECT}
				)`
			);
			this.db.exec(
				`DELETE FROM telemetry_spans WHERE trace_row_id IN (
					SELECT id FROM telemetry_traces WHERE id NOT IN (
						SELECT id FROM telemetry_traces ORDER BY ts DESC LIMIT ${TELEMETRY_MAX_TRACES_TOTAL}
					)
				)`
			);
			this.db.exec(
				`DELETE FROM telemetry_traces WHERE id NOT IN (
					SELECT id FROM telemetry_traces ORDER BY ts DESC LIMIT ${TELEMETRY_MAX_TRACES_TOTAL}
				)`
			);
			this.db.exec('COMMIT');
		} catch (err) {
			this.db.exec('ROLLBACK');
			throw err;
		}
	}
}

/** Nearest-rank percentile over a sorted array. */
function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
	return sorted[i];
}
