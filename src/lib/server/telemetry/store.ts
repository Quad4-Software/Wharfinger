import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { asDb, type Db } from '$lib/server/store/driver';

// Local error-tracking store: the hub's Bugsink/GlitchTip side.
// Projects own a public DSN key; events group into issues by
// fingerprint. Bounds everywhere so a noisy app cannot grow the db.

const TELEMETRY_MAX_EVENTS_PER_PROJECT = 5000;
const TELEMETRY_MAX_EVENTS_TOTAL = 100_000;
const TELEMETRY_MAX_TRACES_PER_PROJECT = 2000;
const TELEMETRY_MAX_TRACES_TOTAL = 20_000;
const STATS_WINDOW = 5000;
// Positional params per statement; chunk id-list deletes under it.
const DELETE_CHUNK = 500;

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

const ISSUE_COLS = `project_id AS projectId, fingerprint, title, culprit, level, first_seen AS firstSeen, last_seen AS lastSeen, count, resolved_at AS resolvedAt`;
const EVENT_COLS = `id, project_id AS projectId, issue_fp AS issueFp, event_id AS eventId, ts, level, platform, message, exc_type AS excType, exc_value AS excValue, release, environment, tags, request, stack, raw`;
const TRACE_COLS = `id, project_id AS projectId, trace_id AS traceId, span_id AS spanId, name, op, ts, duration_ms AS durationMs, span_count AS spanCount, status, release, environment`;

/** Chunked DELETE ... WHERE col IN (?, ...): dynamic lists, no arrays. */
async function deleteWhereIn(
	tx: Db,
	table: string,
	col: string,
	ids: (number | string)[]
): Promise<void> {
	for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
		const part = ids.slice(i, i + DELETE_CHUNK);
		const marks = part.map(() => '?').join(',');
		await tx.prepare(`DELETE FROM ${table} WHERE ${col} IN (${marks})`).run(...part);
	}
}

export class TelemetryStore {
	private readonly db: Db;

	constructor(db: Db | DatabaseSync) {
		this.db = asDb(db);
	}

	async createProject(name: string, platform?: string | null): Promise<TelemetryProject> {
		const key = randomBytes(16).toString('hex');
		const r = await this.db
			.prepare(
				'INSERT INTO telemetry_projects (name, public_key, platform, created_at) VALUES (?, ?, ?, ?)'
			)
			.run(name, key, platform ?? null, Date.now());
		const p = await this.project(Number(r.lastInsertRowid));
		if (!p) throw new Error('telemetry project insert failed');
		return p;
	}

	async project(id: number): Promise<TelemetryProject | null> {
		const r = (await this.db
			.prepare(
				'SELECT id, name, public_key AS publicKey, platform, created_at AS createdAt, disabled_at AS disabledAt FROM telemetry_projects WHERE id = ?'
			)
			.get(id)) as TelemetryProject | undefined;
		return r ?? null;
	}

	async projectByKey(key: string): Promise<TelemetryProject | null> {
		const r = (await this.db
			.prepare(
				'SELECT id, name, public_key AS publicKey, platform, created_at AS createdAt, disabled_at AS disabledAt FROM telemetry_projects WHERE public_key = ?'
			)
			.get(key)) as TelemetryProject | undefined;
		return r ?? null;
	}

	async projects(): Promise<TelemetryProject[]> {
		return (await this.db
			.prepare(
				'SELECT id, name, public_key AS publicKey, platform, created_at AS createdAt, disabled_at AS disabledAt FROM telemetry_projects ORDER BY id'
			)
			.all()) as unknown as TelemetryProject[];
	}

	async setProjectDisabled(id: number, disabled: boolean): Promise<void> {
		await this.db
			.prepare('UPDATE telemetry_projects SET disabled_at = ? WHERE id = ?')
			.run(disabled ? Date.now() : null, id);
	}

	async deleteProject(id: number): Promise<void> {
		await this.db.tx(async (tx) => {
			await tx.prepare('DELETE FROM telemetry_events WHERE project_id = ?').run(id);
			await tx.prepare('DELETE FROM telemetry_issues WHERE project_id = ?').run(id);
			// trace_row_id is a plain int FK, not a record id: the
			// subquery form would compare numbers to record ids on
			// surreal, so the span delete goes through a param list.
			const traceIds = (
				(await tx.prepare('SELECT id FROM telemetry_traces WHERE project_id = ?').all(id)) as {
					id: number;
				}[]
			).map((r) => r.id);
			await deleteWhereIn(tx, 'telemetry_spans', 'trace_row_id', traceIds);
			await tx.prepare('DELETE FROM telemetry_traces WHERE project_id = ?').run(id);
			await tx.prepare('DELETE FROM telemetry_projects WHERE id = ?').run(id);
		});
	}

	/**
	 * Store one parsed event and upsert its issue in one transaction.
	 * A resolved issue that recurs reopens automatically (count keeps
	 * climbing, resolved_at clears).
	 */
	async record(e: StoredEvent): Promise<void> {
		await this.db.tx(async (tx) => {
			await tx
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
			// (project_id, fingerprint) is the record key, so the
			// upsert translates on both drivers.
			await tx
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
		});
	}

	async issues(
		projectId: number | null,
		opts: { limit: number; offset?: number; unresolved?: boolean; q?: string }
	): Promise<{ entries: TelemetryIssue[]; total: number }> {
		const where: string[] = [];
		const args: (string | number)[] = [];
		if (projectId !== null) {
			where.push('project_id = ?');
			args.push(projectId);
		}
		if (opts.unresolved) where.push('resolved_at IS NULL');
		const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
		if (opts.q && this.db.kind === 'surreal') {
			// LIKE is not portable: on surreal the contains-match runs
			// in JS over the already-bounded issue set.
			const rows = (await this.db
				.prepare(`SELECT ${ISSUE_COLS} FROM telemetry_issues ${w} ORDER BY last_seen DESC`)
				.all(...args)) as unknown as TelemetryIssue[];
			const q = opts.q.toLowerCase();
			const hits = rows.filter(
				(r) => r.title.toLowerCase().includes(q) || (r.culprit ?? '').toLowerCase().includes(q)
			);
			const off = opts.offset ?? 0;
			return { entries: hits.slice(off, off + opts.limit), total: hits.length };
		}
		if (opts.q) {
			const like = `%${opts.q.replaceAll('%', '').replaceAll('_', '')}%`;
			where.push('(title LIKE ? OR culprit LIKE ?)');
			args.push(like, like);
		}
		const wq = where.length ? `WHERE ${where.join(' AND ')}` : '';
		const total = (
			(await this.db.prepare(`SELECT COUNT(*) AS n FROM telemetry_issues ${wq}`).get(...args)) as
				{ n: number } | undefined
		)?.n;
		const entries = (await this.db
			.prepare(
				`SELECT ${ISSUE_COLS} FROM telemetry_issues ${wq} ORDER BY last_seen DESC LIMIT ? OFFSET ?`
			)
			.all(...args, opts.limit, opts.offset ?? 0)) as unknown as TelemetryIssue[];
		return { entries, total: total ?? 0 };
	}

	async issue(projectId: number, fingerprint: string): Promise<TelemetryIssue | null> {
		const r = (await this.db
			.prepare(
				`SELECT ${ISSUE_COLS}
				FROM telemetry_issues WHERE project_id = ? AND fingerprint = ?`
			)
			.get(projectId, fingerprint)) as TelemetryIssue | undefined;
		return r ?? null;
	}

	async setIssueResolved(projectId: number, fingerprint: string, resolved: boolean): Promise<void> {
		await this.db
			.prepare(
				'UPDATE telemetry_issues SET resolved_at = ? WHERE project_id = ? AND fingerprint = ?'
			)
			.run(resolved ? Date.now() : null, projectId, fingerprint);
	}

	async events(
		projectId: number,
		fingerprint: string,
		opts: { limit: number; offset?: number }
	): Promise<{ entries: TelemetryEventRow[]; total: number }> {
		const total = (
			(await this.db
				.prepare('SELECT COUNT(*) AS n FROM telemetry_events WHERE project_id = ? AND issue_fp = ?')
				.get(projectId, fingerprint)) as { n: number } | undefined
		)?.n;
		const entries = (await this.db
			.prepare(
				`SELECT ${EVENT_COLS}
				FROM telemetry_events WHERE project_id = ? AND issue_fp = ? ORDER BY ts DESC LIMIT ? OFFSET ?`
			)
			.all(projectId, fingerprint, opts.limit, opts.offset ?? 0)) as unknown as TelemetryEventRow[];
		return { entries, total: total ?? 0 };
	}

	async eventById(id: number): Promise<TelemetryEventRow | null> {
		const r = (await this.db
			.prepare(
				`SELECT ${EVENT_COLS}
				FROM telemetry_events WHERE id = ?`
			)
			.get(id)) as TelemetryEventRow | undefined;
		return r ?? null;
	}

	/** Store one transaction and its spans in a single transaction. */
	async recordTrace(t: StoredTrace): Promise<void> {
		await this.db.tx(async (tx) => {
			const r = await tx
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
			const ins = tx.prepare(
				`INSERT INTO telemetry_spans
				(trace_row_id, span_id, parent_span_id, op, description, start_ms, end_ms, status, data)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			);
			for (const s of t.spans) {
				await ins.run(
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
		});
	}

	async traces(
		projectId: number,
		opts: { limit: number; offset?: number; q?: string; name?: string }
	): Promise<{ entries: TelemetryTrace[]; total: number }> {
		const where = ['project_id = ?'];
		const args: (string | number)[] = [projectId];
		if (opts.name) {
			where.push('name = ?');
			args.push(opts.name);
		}
		const w = `WHERE ${where.join(' AND ')}`;
		if (opts.q && this.db.kind === 'surreal') {
			// Same as issues(): contains-match in JS on surreal.
			const rows = (await this.db
				.prepare(`SELECT ${TRACE_COLS} FROM telemetry_traces ${w} ORDER BY ts DESC`)
				.all(...args)) as unknown as TelemetryTrace[];
			const q = opts.q.toLowerCase();
			const hits = rows.filter(
				(r) => r.name.toLowerCase().includes(q) || r.traceId.toLowerCase().includes(q)
			);
			const off = opts.offset ?? 0;
			return { entries: hits.slice(off, off + opts.limit), total: hits.length };
		}
		if (opts.q) {
			const like = `%${opts.q.replaceAll('%', '').replaceAll('_', '')}%`;
			where.push('(name LIKE ? OR trace_id LIKE ?)');
			args.push(like, like);
		}
		const wq = `WHERE ${where.join(' AND ')}`;
		const total = (
			(await this.db.prepare(`SELECT COUNT(*) AS n FROM telemetry_traces ${wq}`).get(...args)) as
				{ n: number } | undefined
		)?.n;
		const entries = (await this.db
			.prepare(`SELECT ${TRACE_COLS} FROM telemetry_traces ${wq} ORDER BY ts DESC LIMIT ? OFFSET ?`)
			.all(...args, opts.limit, opts.offset ?? 0)) as unknown as TelemetryTrace[];
		return { entries, total: total ?? 0 };
	}

	/** Newest trace row for a Sentry trace_id plus its ordered spans. */
	async trace(
		projectId: number,
		traceId: string
	): Promise<{ trace: TelemetryTrace; spans: TelemetrySpan[] } | null> {
		const t = (await this.db
			.prepare(
				`SELECT ${TRACE_COLS}
				FROM telemetry_traces WHERE project_id = ? AND trace_id = ? ORDER BY ts DESC LIMIT 1`
			)
			.get(projectId, traceId)) as TelemetryTrace | undefined;
		if (!t) return null;
		const spans = (await this.db
			.prepare(
				`SELECT span_id AS spanId, parent_span_id AS parentSpanId, op, description, start_ms AS startMs, end_ms AS endMs, status, data
				FROM telemetry_spans WHERE trace_row_id = ? ORDER BY start_ms`
			)
			.all(t.id)) as unknown as TelemetrySpan[];
		return { trace: t, spans };
	}

	/** Per-transaction-name latency stats over the most recent rows. */
	async transactionStats(projectId: number): Promise<TransactionStat[]> {
		const rows = (await this.db
			.prepare(
				`SELECT name, duration_ms AS d, ts FROM telemetry_traces
				WHERE project_id = ? ORDER BY ts DESC LIMIT ${STATS_WINDOW}`
			)
			.all(projectId)) as { name: string; d: number; ts: number }[];
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

	/**
	 * Per-project and global caps; cheap row-count maintenance.
	 * Window functions and id IN (SELECT) are not portable, so the
	 * rows past each cap are picked by an ordered id scan and deleted
	 * by id list inside one transaction.
	 */
	async prune(): Promise<void> {
		await this.db.tx(async (tx) => {
			const projects = (await tx.prepare('SELECT id FROM telemetry_projects').all()) as {
				id: number;
			}[];

			// Per-project event cap: ids sorted newest first, drop the tail.
			for (const p of projects) {
				const ids = (
					(await tx
						.prepare('SELECT id FROM telemetry_events WHERE project_id = ? ORDER BY ts DESC')
						.all(p.id)) as { id: number }[]
				).map((r) => r.id);
				await deleteWhereIn(
					tx,
					'telemetry_events',
					'id',
					ids.slice(TELEMETRY_MAX_EVENTS_PER_PROJECT)
				);
			}
			// Global event cap across every project.
			const eventIds = (
				(await tx.prepare('SELECT id FROM telemetry_events ORDER BY ts DESC').all()) as {
					id: number;
				}[]
			).map((r) => r.id);
			await deleteWhereIn(tx, 'telemetry_events', 'id', eventIds.slice(TELEMETRY_MAX_EVENTS_TOTAL));

			// Trace caps collect the doomed row ids; their spans must go
			// with them so a waterfall never outlives its trace.
			const doomedTraces: number[] = [];
			for (const p of projects) {
				const ids = (
					(await tx
						.prepare('SELECT id FROM telemetry_traces WHERE project_id = ? ORDER BY ts DESC')
						.all(p.id)) as { id: number }[]
				).map((r) => r.id);
				doomedTraces.push(...ids.slice(TELEMETRY_MAX_TRACES_PER_PROJECT));
			}
			const traceIds = (
				(await tx.prepare('SELECT id FROM telemetry_traces ORDER BY ts DESC').all()) as {
					id: number;
				}[]
			).map((r) => r.id);
			doomedTraces.push(...traceIds.slice(TELEMETRY_MAX_TRACES_TOTAL));
			await deleteWhereIn(tx, 'telemetry_spans', 'trace_row_id', doomedTraces);
			await deleteWhereIn(tx, 'telemetry_traces', 'id', doomedTraces);
		});
	}
}

/** Nearest-rank percentile over a sorted array. */
function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
	return sorted[i];
}
