import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AUDIT_LOG_MAX } from '$lib/server/constants';

export interface AuditEntry {
	id: number;
	userId: number | null;
	username: string | null;
	action: string;
	detail: string | null;
	ip: string | null;
	at: number;
}

// First row in the log chains from a fixed all-zero hash.
export const AUDIT_GENESIS = '0'.repeat(64);

export interface AuditHashRow {
	id: number;
	user_id: number | null;
	username: string | null;
	action: string;
	detail: string | null;
	ip: string | null;
	at: number;
}

// Canonical serialization for the tamper-evident chain: fixed field
// order with nulls preserved, so a row always hashes the same way.
export function auditRowHash(row: AuditHashRow, prevHash: string): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				row.id,
				row.user_id,
				row.username,
				row.action,
				row.detail,
				row.ip,
				row.at,
				prevHash
			])
		)
		.digest('hex');
}

export class AuditStore {
	constructor(private readonly db: DatabaseSync) {}

	log(
		entry: {
			userId?: number | null;
			username?: string | null;
			action: string;
			detail?: string | null;
			ip?: string | null;
		},
		now = Date.now()
	): void {
		// The head read and the insert are back-to-back synchronous calls
		// on one connection, so two log() calls cannot interleave.
		const head = this.db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get() as
			{ hash: string | null } | undefined;
		const prevHash = head?.hash ?? AUDIT_GENESIS;
		const userId = entry.userId ?? null;
		const username = entry.username ?? null;
		const detail = entry.detail ?? null;
		const ip = entry.ip ?? null;
		const r = this.db
			.prepare(
				'INSERT INTO audit_log (user_id, username, action, detail, ip, at, prev_hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
			)
			.run(userId, username, entry.action, detail, ip, now, prevHash);
		// The row id joins the hash, so it lands in a second statement.
		const id = Number(r.lastInsertRowid);
		const hash = auditRowHash(
			{ id, user_id: userId, username, action: entry.action, detail, ip, at: now },
			prevHash
		);
		this.db.prepare('UPDATE audit_log SET hash = ? WHERE id = ?').run(hash, id);
	}

	/**
	 * Walk the hash chain over the whole log. The oldest surviving row
	 * may chain from a pruned predecessor, so only its own hash is
	 * recomputed; every later row must also link to the row before it.
	 */
	verify(): { ok: boolean; rows: number; firstBadId?: number } {
		const rows = this.db
			.prepare(
				'SELECT id, user_id, username, action, detail, ip, at, prev_hash, hash FROM audit_log ORDER BY id ASC'
			)
			.all() as unknown as (AuditHashRow & { prev_hash: string | null; hash: string | null })[];
		let prev: string | null = null;
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			const linked = prev === null || row.prev_hash === prev;
			const intact =
				row.hash !== null && row.hash === auditRowHash(row, row.prev_hash ?? AUDIT_GENESIS);
			if (!linked || !intact) return { ok: false, rows: i + 1, firstBadId: row.id };
			prev = row.hash;
		}
		return { ok: true, rows: rows.length };
	}

	list(opts: { limit: number; offset: number; action?: string; q?: string; user?: string }): {
		entries: AuditEntry[];
		total: number;
	} {
		const { where, args } = this.filters(opts);
		const total = (
			this.db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`).get(...args) as {
				n: number;
			}
		).n;
		const entries = this.db
			.prepare(
				`SELECT id, user_id AS userId, username, action, detail, ip, at FROM audit_log ${where} ORDER BY at DESC LIMIT ? OFFSET ?`
			)
			.all(...args, opts.limit, opts.offset) as unknown as AuditEntry[];
		return { entries, total };
	}

	/** Same filters as list() without pagination, for export. */
	exportRows(opts: { action?: string; q?: string; user?: string; max: number }): AuditEntry[] {
		const { where, args } = this.filters(opts);
		return this.db
			.prepare(
				`SELECT id, user_id AS userId, username, action, detail, ip, at FROM audit_log ${where} ORDER BY at DESC LIMIT ?`
			)
			.all(...args, opts.max) as unknown as AuditEntry[];
	}

	private filters(opts: { action?: string; q?: string; user?: string }): {
		where: string;
		args: (string | number)[];
	} {
		const parts: string[] = [];
		const args: (string | number)[] = [];
		if (opts.action) {
			parts.push('action = ?');
			args.push(opts.action);
		}
		if (opts.user) {
			parts.push('username = ?');
			args.push(opts.user);
		}
		const q = opts.q?.trim();
		if (q) {
			const like = `%${q.replaceAll('%', '').replaceAll('_', '')}%`;
			parts.push('(username LIKE ? OR detail LIKE ? OR ip LIKE ? OR action LIKE ?)');
			args.push(like, like, like, like);
		}
		return { where: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args };
	}

	/**
	 * Aggregate counts for the KPI strip on the audit page. Runs one
	 * bounded pass over the filtered set so the numbers always match the
	 * rows the admin is looking at.
	 */
	summary(opts: { action?: string; q?: string; user?: string }): {
		today: number;
		week: number;
		actors: number;
		failedAuth: number;
	} {
		const { where, args } = this.filters(opts);
		const dayStart = new Date();
		dayStart.setHours(0, 0, 0, 0);
		const weekStart = Date.now() - 7 * 86_400_000;
		const row = this.db
			.prepare(
				`SELECT
					COALESCE(SUM(CASE WHEN at >= ? THEN 1 ELSE 0 END), 0) AS today,
					COALESCE(SUM(CASE WHEN at >= ? THEN 1 ELSE 0 END), 0) AS week,
					COUNT(DISTINCT username) AS actors,
					COALESCE(SUM(CASE WHEN action LIKE 'auth.%' AND (
						action LIKE '%.fail' OR action LIKE '%.denied' OR action LIKE '%.disabled'
					) THEN 1 ELSE 0 END), 0) AS failedAuth
				FROM audit_log ${where}`
			)
			.get(dayStart.getTime(), weekStart, ...args) as unknown as {
			today: number;
			week: number;
			actors: number;
			failedAuth: number;
		};
		return row;
	}

	actions(): string[] {
		return (
			this.db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all() as unknown as {
				action: string;
			}[]
		).map((r) => r.action);
	}

	prune(): void {
		this.db
			.prepare(
				`DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY at DESC LIMIT ?)`
			)
			.run(AUDIT_LOG_MAX);
	}
}
