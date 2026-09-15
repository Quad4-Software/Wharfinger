import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { asDb, rawSqlite, type Db } from '$lib/server/store/driver';
import {
	MAX_FINDINGS_PER_REPORT,
	MAX_PKG,
	MAX_REC_DETAIL,
	MAX_REC_TITLE,
	MAX_SCAN_ERROR,
	MAX_TARGET,
	MAX_TITLE,
	MAX_VERSION,
	MAX_VULN_ID,
	SEVERITIES,
	emptySummary
} from '$lib/shared/scan';
import type {
	NewRecommendation,
	Recommendation,
	RecommendationKind,
	RecommendationStatus,
	ScanFinding,
	ScanReport,
	ScanStatus,
	Severity
} from '$lib/shared/scan';
import { DeployError } from '$lib/server/deploy/store';

// Tables are created lazily here rather than in store/db.ts because
// the scan schema ships independently of the core migration block.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS scan_reports (
	id          TEXT PRIMARY KEY,
	app_id      TEXT NOT NULL,
	release_id  TEXT,
	target      TEXT NOT NULL,
	scanner     TEXT NOT NULL DEFAULT 'trivy',
	status      TEXT NOT NULL DEFAULT 'queued',
	started_at  INTEGER NOT NULL,
	finished_at INTEGER,
	critical    INTEGER NOT NULL DEFAULT 0,
	high        INTEGER NOT NULL DEFAULT 0,
	medium      INTEGER NOT NULL DEFAULT 0,
	low         INTEGER NOT NULL DEFAULT 0,
	unknown     INTEGER NOT NULL DEFAULT 0,
	duration_ms INTEGER,
	error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_scan_reports_app ON scan_reports (app_id, started_at DESC);

CREATE TABLE IF NOT EXISTS scan_findings (
	report_id TEXT NOT NULL,
	vuln_id   TEXT NOT NULL,
	pkg       TEXT NOT NULL,
	installed TEXT,
	fixed     TEXT,
	severity  TEXT NOT NULL,
	title     TEXT,
	cvss      REAL
);
CREATE INDEX IF NOT EXISTS idx_scan_findings_report ON scan_findings (report_id);

-- dedupe key scopes repeats inside a kind (a dismissed rec stays
-- dismissed; an open rec whose condition cleared is deleted so a
-- regression can re-raise it later).
CREATE TABLE IF NOT EXISTS recommendations (
	id           TEXT PRIMARY KEY,
	app_id       TEXT NOT NULL,
	kind         TEXT NOT NULL,
	dedupe_key   TEXT NOT NULL DEFAULT '',
	severity     TEXT NOT NULL,
	title        TEXT NOT NULL,
	detail       TEXT NOT NULL,
	data         TEXT,
	auto_fixable INTEGER NOT NULL DEFAULT 0,
	status       TEXT NOT NULL DEFAULT 'open',
	created_at   INTEGER NOT NULL,
	applied_at   INTEGER,
	UNIQUE (app_id, kind, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_recommendations_app ON recommendations (app_id, status);
`;

interface ReportRow {
	id: string;
	app_id: string;
	release_id: string | null;
	target: string;
	scanner: string;
	status: string;
	started_at: number;
	finished_at: number | null;
	critical: number;
	high: number;
	medium: number;
	low: number;
	unknown: number;
	duration_ms: number | null;
	error: string | null;
}

interface FindingRow {
	report_id: string;
	vuln_id: string;
	pkg: string;
	installed: string | null;
	fixed: string | null;
	severity: string;
	title: string | null;
	cvss: number | null;
}

interface RecRow {
	id: string;
	app_id: string;
	kind: string;
	dedupe_key: string;
	severity: string;
	title: string;
	detail: string;
	data: string | null;
	auto_fixable: number;
	status: string;
	created_at: number;
	applied_at: number | null;
}

function toReport(r: ReportRow): ScanReport {
	return {
		id: r.id,
		appId: r.app_id,
		releaseId: r.release_id ?? undefined,
		target: r.target,
		scanner: 'trivy',
		startedAt: r.started_at,
		finishedAt: r.finished_at ?? undefined,
		status: r.status as ScanStatus,
		summary: {
			critical: r.critical,
			high: r.high,
			medium: r.medium,
			low: r.low,
			unknown: r.unknown
		},
		durationMs: r.duration_ms ?? undefined,
		error: r.error ?? undefined
	};
}

function toFinding(r: FindingRow): ScanFinding {
	return {
		reportId: r.report_id,
		vulnId: r.vuln_id,
		pkg: r.pkg,
		installed: r.installed ?? undefined,
		fixed: r.fixed ?? undefined,
		severity: r.severity as Severity,
		title: r.title ?? undefined,
		cvss: r.cvss ?? undefined
	};
}

function toRec(r: RecRow): Recommendation {
	return {
		id: r.id,
		appId: r.app_id,
		kind: r.kind as RecommendationKind,
		dedupeKey: r.dedupe_key,
		severity: r.severity as Recommendation['severity'],
		title: r.title,
		detail: r.detail,
		data: r.data ? (JSON.parse(r.data) as Record<string, unknown>) : undefined,
		autoFixable: r.auto_fixable === 1,
		status: r.status as RecommendationStatus,
		createdAt: r.created_at,
		appliedAt: r.applied_at ?? undefined
	};
}

function clip(v: unknown, max: number): string | undefined {
	if (typeof v !== 'string' || !v) return undefined;
	return v.slice(0, max);
}

function normSeverity(v: unknown): Severity {
	const s = String(v).toLowerCase();
	return (SEVERITIES as readonly string[]).includes(s) ? (s as Severity) : 'unknown';
}

// CASE-based severity ordering is not portable SQL, so findings are
// ranked in memory after the fetch.
const SEV_RANK = new Map<string, number>([
	['critical', 0],
	['high', 1],
	['medium', 2],
	['low', 3]
]);

/**
 * Scan reports, findings, and hardening recommendations. Created via
 * getScanStore so the tables initialize lazily on whatever db handle
 * the runtime hands over.
 */
export class ScanStore {
	private readonly db: Db;

	constructor(db: Db | DatabaseSync) {
		this.db = asDb(db);
		// Lazy DDL is a sqlite-only path; under surreal the shared schema
		// (store/schema.ts) already defines these tables.
		rawSqlite(this.db)?.exec(SCHEMA);
	}

	async createReport(opts: {
		appId: string;
		target: string;
		releaseId?: string;
		scanner?: string;
		id?: string;
		now?: number;
	}): Promise<ScanReport> {
		const id = opts.id ?? `scan_${randomBytes(9).toString('base64url')}`;
		const now = opts.now ?? Date.now();
		await this.db
			.prepare(
				`INSERT INTO scan_reports (id, app_id, release_id, target, scanner, status, started_at)
				 VALUES (?, ?, ?, ?, ?, 'queued', ?)`
			)
			.run(
				id,
				opts.appId,
				opts.releaseId ?? null,
				opts.target.slice(0, MAX_TARGET),
				opts.scanner ?? 'trivy',
				now
			);
		const report = await this.report(id);
		if (!report) throw new DeployError(500, 'scan report missing after create');
		return report;
	}

	async report(id: string): Promise<ScanReport | null> {
		const row = (await this.db.prepare('SELECT * FROM scan_reports WHERE id = ?').get(id)) as
			ReportRow | undefined;
		return row ? toReport(row) : null;
	}

	async listForApp(appId: string, limit = 50): Promise<ScanReport[]> {
		return (
			(await this.db
				.prepare('SELECT * FROM scan_reports WHERE app_id = ? ORDER BY started_at DESC LIMIT ?')
				.all(appId, Math.min(Math.max(limit, 1), 200))) as unknown as ReportRow[]
		).map(toReport);
	}

	async latestForApp(appId: string): Promise<ScanReport | null> {
		const row = (await this.db
			.prepare('SELECT * FROM scan_reports WHERE app_id = ? ORDER BY started_at DESC LIMIT 1')
			.get(appId)) as ReportRow | undefined;
		return row ? toReport(row) : null;
	}

	/** Most recent report per app, for the fleet view. */
	async latestPerApp(limit = 200): Promise<ScanReport[]> {
		// Correlated subquery stands in for the JOIN the surreal
		// translator cannot express; ties on started_at return every
		// matching report just like the original join.
		return (
			(await this.db
				.prepare(
					`SELECT r.* FROM scan_reports r
					 WHERE r.started_at = (
					   SELECT MAX(started_at) FROM scan_reports WHERE app_id = r.app_id
					 )
					 ORDER BY r.started_at DESC LIMIT ?`
				)
				.all(Math.min(Math.max(limit, 1), 500))) as unknown as ReportRow[]
		).map(toReport);
	}

	/** The in-flight report for an app, used to dedupe scan triggers. */
	async activeForApp(appId: string): Promise<ScanReport | null> {
		const row = (await this.db
			.prepare(
				`SELECT * FROM scan_reports WHERE app_id = ? AND status IN ('queued', 'running')
				 ORDER BY started_at DESC LIMIT 1`
			)
			.get(appId)) as ReportRow | undefined;
		return row ? toReport(row) : null;
	}

	async markRunning(id: string, now = Date.now()): Promise<void> {
		await this.db
			.prepare(
				`UPDATE scan_reports SET status = 'running', started_at = ?
				 WHERE id = ? AND status = 'queued'`
			)
			.run(now, id);
	}

	/**
	 * Terminal transition. Findings insert in one transaction and the
	 * summary rollup is recomputed from what actually landed, so a
	 * malformed agent summary cannot inflate the stored counts.
	 */
	async complete(
		id: string,
		outcome: 'done' | 'failed',
		opts: { finishedAt?: number; error?: string; findings?: Omit<ScanFinding, 'reportId'>[] } = {}
	): Promise<ScanReport | null> {
		const existing = await this.report(id);
		if (!existing) return null;
		if (existing.status === 'done' || existing.status === 'failed') return existing;
		const finishedAt = opts.finishedAt ?? Date.now();
		const findings = (opts.findings ?? []).slice(0, MAX_FINDINGS_PER_REPORT);
		const summary = emptySummary();
		const seen = new Set<string>();
		const rows: (string | number | null)[][] = [];
		for (const f of findings) {
			const vulnId = clip(f.vulnId, MAX_VULN_ID);
			const pkg = clip(f.pkg, MAX_PKG);
			if (!vulnId || !pkg) continue;
			const key = `${vulnId}${pkg}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const severity = normSeverity(f.severity);
			summary[severity] += 1;
			rows.push([
				id,
				vulnId,
				pkg,
				clip(f.installed, MAX_VERSION) ?? null,
				clip(f.fixed, MAX_VERSION) ?? null,
				severity,
				clip(f.title, MAX_TITLE) ?? null,
				typeof f.cvss === 'number' && Number.isFinite(f.cvss)
					? Math.min(Math.max(f.cvss, 0), 10)
					: null
			]);
		}
		return this.db.tx(async (tx) => {
			// Conditional transition first: a second completion for the
			// same report (retried result post) must not rewrite it.
			const changed = await tx
				.prepare(
					`UPDATE scan_reports SET status = ?, finished_at = ?, duration_ms = ?,
						critical = ?, high = ?, medium = ?, low = ?, unknown = ?, error = ?
					 WHERE id = ? AND status IN ('queued', 'running')`
				)
				.run(
					outcome,
					finishedAt,
					Math.max(0, finishedAt - existing.startedAt),
					summary.critical,
					summary.high,
					summary.medium,
					summary.low,
					summary.unknown,
					clip(opts.error, MAX_SCAN_ERROR) ?? null,
					id
				);
			if (!Number(changed.changes)) {
				const row = (await tx.prepare('SELECT * FROM scan_reports WHERE id = ?').get(id)) as
					ReportRow | undefined;
				return row ? toReport(row) : null;
			}
			await tx.prepare('DELETE FROM scan_findings WHERE report_id = ?').run(id);
			const ins = tx.prepare(
				`INSERT INTO scan_findings (report_id, vuln_id, pkg, installed, fixed, severity, title, cvss)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			);
			for (const r of rows) await ins.run(...r);
			const row = (await tx.prepare('SELECT * FROM scan_reports WHERE id = ?').get(id)) as
				ReportRow | undefined;
			return row ? toReport(row) : null;
		});
	}

	async findings(reportId: string, limit = MAX_FINDINGS_PER_REPORT): Promise<ScanFinding[]> {
		// Stored findings are already capped at MAX_FINDINGS_PER_REPORT
		// by complete(), so the fetch bound cannot drop a row the
		// caller asked for; severity ranking happens in memory.
		const rows = (await this.db
			.prepare('SELECT * FROM scan_findings WHERE report_id = ? ORDER BY vuln_id LIMIT ?')
			.all(reportId, MAX_FINDINGS_PER_REPORT)) as unknown as FindingRow[];
		rows.sort((a, b) => (SEV_RANK.get(a.severity) ?? 4) - (SEV_RANK.get(b.severity) ?? 4));
		return rows.slice(0, Math.min(Math.max(limit, 1), MAX_FINDINGS_PER_REPORT)).map(toFinding);
	}

	async rec(id: string): Promise<Recommendation | null> {
		const row = (await this.db.prepare('SELECT * FROM recommendations WHERE id = ?').get(id)) as
			RecRow | undefined;
		return row ? toRec(row) : null;
	}

	async recsForApp(
		appId: string,
		opts: { openOnly?: boolean; limit?: number } = {}
	): Promise<Recommendation[]> {
		const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
		const rows =
			opts.openOnly === false
				? ((await this.db
						.prepare(
							'SELECT * FROM recommendations WHERE app_id = ? ORDER BY created_at DESC LIMIT ?'
						)
						.all(appId, limit)) as unknown as RecRow[])
				: ((await this.db
						.prepare(
							`SELECT * FROM recommendations WHERE app_id = ? AND status = 'open'
						 ORDER BY created_at DESC LIMIT ?`
						)
						.all(appId, limit)) as unknown as RecRow[]);
		return rows.map(toRec);
	}

	/** Every open recommendation, fleet view. */
	async allOpen(limit = 500): Promise<Recommendation[]> {
		return (
			(await this.db
				.prepare(
					`SELECT * FROM recommendations WHERE status = 'open'
					 ORDER BY created_at DESC LIMIT ?`
				)
				.all(Math.min(Math.max(limit, 1), 1000))) as unknown as RecRow[]
		).map(toRec);
	}

	/** Open recommendation counts per app. */
	async openCounts(): Promise<Map<string, number>> {
		const rows = (await this.db
			.prepare(
				`SELECT app_id, COUNT(*) AS c FROM recommendations WHERE status = 'open' GROUP BY app_id`
			)
			.all()) as unknown as { app_id: string; c: number }[];
		return new Map(rows.map((r) => [r.app_id, r.c]));
	}

	/**
	 * Reconcile a fresh evaluation against stored recs in one
	 * transaction. Dismissed and wontfix rows suppress duplicates;
	 * applied rows reopen when the condition regresses; open rows
	 * whose condition cleared are deleted outright.
	 */
	async sync(
		appId: string,
		recs: NewRecommendation[],
		now = Date.now()
	): Promise<Recommendation[]> {
		const seen = new Set(recs.map((r) => `${r.kind}${r.dedupeKey}`));
		await this.db.tx(async (tx) => {
			const existing = (await tx
				.prepare('SELECT * FROM recommendations WHERE app_id = ?')
				.all(appId)) as unknown as RecRow[];
			const byKey = new Map(existing.map((r) => [`${r.kind}${r.dedupe_key}`, r]));
			const insert = tx.prepare(
				`INSERT INTO recommendations
					(id, app_id, kind, dedupe_key, severity, title, detail, data, auto_fixable, status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
			);
			const refresh = tx.prepare(
				`UPDATE recommendations SET severity = ?, title = ?, detail = ?, data = ?, auto_fixable = ?
				 WHERE id = ?`
			);
			const reopen = tx.prepare(
				`UPDATE recommendations SET status = 'open', applied_at = NULL, created_at = ?,
					severity = ?, title = ?, detail = ?, data = ?, auto_fixable = ?
				 WHERE id = ?`
			);
			for (const rec of recs) {
				const key = `${rec.kind}${rec.dedupeKey}`;
				const title = rec.title.slice(0, MAX_REC_TITLE);
				const detail = rec.detail.slice(0, MAX_REC_DETAIL);
				const data = rec.data ? JSON.stringify(rec.data).slice(0, 4096) : null;
				const cur = byKey.get(key);
				if (!cur) {
					await insert.run(
						`rec_${randomBytes(9).toString('base64url')}`,
						appId,
						rec.kind,
						rec.dedupeKey,
						rec.severity,
						title,
						detail,
						data,
						rec.autoFixable ? 1 : 0,
						now
					);
				} else if (cur.status === 'open') {
					await refresh.run(rec.severity, title, detail, data, rec.autoFixable ? 1 : 0, cur.id);
				} else if (cur.status === 'applied') {
					await reopen.run(now, rec.severity, title, detail, data, rec.autoFixable ? 1 : 0, cur.id);
				}
				// dismissed and wontfix stay untouched: user intent wins.
			}
			const del = tx.prepare("DELETE FROM recommendations WHERE id = ? AND status = 'open'");
			for (const cur of existing) {
				if (cur.status === 'open' && !seen.has(`${cur.kind}${cur.dedupe_key}`)) {
					await del.run(cur.id);
				}
			}
		});
		return this.recsForApp(appId);
	}

	/**
	 * Conditional status update; returns false when the rec is not
	 * currently open, which makes double-apply and double-dismiss a
	 * single statement instead of a read-check-write race.
	 */
	async setStatus(
		id: string,
		status: 'applied' | 'dismissed' | 'wontfix',
		now = Date.now()
	): Promise<boolean> {
		const res = await this.db
			.prepare(
				`UPDATE recommendations SET status = ?, applied_at = ?
				 WHERE id = ? AND status = 'open'`
			)
			.run(status, status === 'applied' ? now : null, id);
		return Number(res.changes) === 1;
	}

	/** Drop old reports (and their findings) plus resolved recs. */
	async prune(olderThan: number): Promise<number> {
		return this.db.tx(async (tx) => {
			const stale = (await tx
				.prepare('SELECT id FROM scan_reports WHERE started_at < ?')
				.all(olderThan)) as unknown as { id: string }[];
			const delF = tx.prepare('DELETE FROM scan_findings WHERE report_id = ?');
			const delR = tx.prepare('DELETE FROM scan_reports WHERE id = ?');
			for (const { id } of stale) {
				await delF.run(id);
				await delR.run(id);
			}
			await tx
				.prepare("DELETE FROM recommendations WHERE status != 'open' AND created_at < ?")
				.run(olderThan);
			return stale.length;
		});
	}
}

// One store per db handle so tests on fresh temp databases never see
// a stale singleton pointing at a closed file.
const stores = new WeakMap<Db | DatabaseSync, ScanStore>();

export function getScanStore(db: Db | DatabaseSync): ScanStore {
	let s = stores.get(db);
	if (!s) {
		s = new ScanStore(db);
		stores.set(db, s);
	}
	return s;
}
