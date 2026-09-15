import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AUDIT_LOG_MAX } from '$lib/server/constants';
import { asDb, type Db, type SqlValue } from '$lib/server/store/driver';

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

const ENTRY_SELECT =
	'SELECT id, user_id AS userId, username, action, detail, ip, at FROM audit_log';

interface LogEntry {
	userId?: number | null;
	username?: string | null;
	action: string;
	detail?: string | null;
	ip?: string | null;
}

interface FilterOpts {
	action?: string;
	q?: string;
	user?: string;
}

export class AuditStore {
	private readonly db: Db;
	// Each log() reads the chain head before writing; the mutex keeps a
	// concurrent log() from interleaving its head read between another
	// call's read and insert, which would fork the chain.
	private chain: Promise<unknown> = Promise.resolve();

	constructor(db: Db | DatabaseSync) {
		this.db = asDb(db);
	}

	log(entry: LogEntry, now = Date.now()): Promise<void> {
		// Write failures resolve rather than reject: most callers log
		// fire-and-forget, and an unhandled rejection would take the
		// process down over a bookkeeping row.
		const run = this.chain
			.then(() => this.writeEntry(entry, now))
			.catch((err: unknown) => {
				console.warn('[audit] failed to write entry:', err);
			});
		this.chain = run;
		return run;
	}

	private async writeEntry(entry: LogEntry, now: number): Promise<void> {
		const head = (await this.db
			.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1')
			.get()) as { hash: string | null } | undefined;
		const prevHash = head?.hash ?? AUDIT_GENESIS;
		const userId = entry.userId ?? null;
		const username = entry.username ?? null;
		const detail = entry.detail ?? null;
		const ip = entry.ip ?? null;
		const r = await this.db
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
		await this.db.prepare('UPDATE audit_log SET hash = ? WHERE id = ?').run(hash, id);
	}

	/**
	 * Walk the hash chain over the whole log. The oldest surviving row
	 * may chain from a pruned predecessor, so only its own hash is
	 * recomputed; every later row must also link to the row before it.
	 */
	async verify(): Promise<{ ok: boolean; rows: number; firstBadId?: number }> {
		const rows = (await this.db
			.prepare(
				'SELECT id, user_id, username, action, detail, ip, at, prev_hash, hash FROM audit_log ORDER BY id ASC'
			)
			.all()) as unknown as (AuditHashRow & { prev_hash: string | null; hash: string | null })[];
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

	async list(opts: {
		limit: number;
		offset: number;
		action?: string;
		q?: string;
		user?: string;
	}): Promise<{ entries: AuditEntry[]; total: number }> {
		const { where, args } = filters(opts);
		const q = needle(opts.q);
		if (q === null) {
			const total = (
				(await this.db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`).get(...args)) as {
					n: number;
				}
			).n;
			const entries = (await this.db
				.prepare(`${ENTRY_SELECT} ${where} ORDER BY at DESC LIMIT ? OFFSET ?`)
				.all(...args, opts.limit, opts.offset)) as unknown as AuditEntry[];
			return { entries, total };
		}
		// LIKE is outside the portable dialect; the substring search
		// runs in memory over the rows the exact filters already bound.
		// audit_log is capped at AUDIT_LOG_MAX rows, so the scan stays
		// bounded.
		const matched = (await this.filteredRows(where, args)).filter((e) => matches(e, q));
		return {
			entries: matched.slice(opts.offset, opts.offset + opts.limit),
			total: matched.length
		};
	}

	/** Same filters as list() without pagination, for export. */
	async exportRows(opts: {
		action?: string;
		q?: string;
		user?: string;
		max: number;
	}): Promise<AuditEntry[]> {
		const { where, args } = filters(opts);
		const q = needle(opts.q);
		if (q === null) {
			return (await this.db
				.prepare(`${ENTRY_SELECT} ${where} ORDER BY at DESC LIMIT ?`)
				.all(...args, opts.max)) as unknown as AuditEntry[];
		}
		return (await this.filteredRows(where, args)).filter((e) => matches(e, q)).slice(0, opts.max);
	}

	private async filteredRows(where: string, args: SqlValue[]): Promise<AuditEntry[]> {
		return (await this.db
			.prepare(`${ENTRY_SELECT} ${where} ORDER BY at DESC`)
			.all(...args)) as unknown as AuditEntry[];
	}

	/**
	 * Aggregate counts for the KPI strip on the audit page. COUNT
	 * DISTINCT and LIKE are outside the portable dialect, so the
	 * filtered rows are tallied in memory; the log is capped at
	 * AUDIT_LOG_MAX so the pass stays bounded.
	 */
	async summary(opts: FilterOpts): Promise<{
		today: number;
		week: number;
		actors: number;
		failedAuth: number;
	}> {
		const { where, args } = filters(opts);
		const q = needle(opts.q);
		const rows = await this.filteredRows(where, args);
		const dayStart = new Date();
		dayStart.setHours(0, 0, 0, 0);
		const dayStartMs = dayStart.getTime();
		const weekStart = Date.now() - 7 * 86_400_000;
		const actors = new Set<string>();
		let today = 0;
		let week = 0;
		let failedAuth = 0;
		for (const e of rows) {
			if (q !== null && !matches(e, q)) continue;
			if (e.at >= dayStartMs) today++;
			if (e.at >= weekStart) week++;
			if (e.username !== null) actors.add(e.username);
			if (
				e.action.startsWith('auth.') &&
				(e.action.endsWith('.fail') ||
					e.action.endsWith('.denied') ||
					e.action.endsWith('.disabled'))
			) {
				failedAuth++;
			}
		}
		return { today, week, actors: actors.size, failedAuth };
	}

	async actions(): Promise<string[]> {
		const rows = (await this.db
			.prepare('SELECT action FROM audit_log ORDER BY action')
			.all()) as unknown as { action: string }[];
		return [...new Set(rows.map((r) => r.action))];
	}

	/**
	 * Keep only the newest AUDIT_LOG_MAX entries. The surviving ids are
	 * selected first because the translator cannot nest a LIMIT inside
	 * the delete's NOT IN.
	 */
	async prune(): Promise<void> {
		const keep = (await this.db
			.prepare('SELECT id FROM audit_log ORDER BY at DESC LIMIT ?')
			.all(AUDIT_LOG_MAX)) as unknown as { id: number }[];
		if (keep.length === 0) {
			await this.db.prepare('DELETE FROM audit_log').run();
			return;
		}
		await this.db
			.prepare(`DELETE FROM audit_log WHERE id NOT IN (${keep.map(() => '?').join(',')})`)
			.run(...keep.map((k) => k.id));
	}
}

function filters(opts: FilterOpts): { where: string; args: SqlValue[] } {
	const parts: string[] = [];
	const args: SqlValue[] = [];
	if (opts.action) {
		parts.push('action = ?');
		args.push(opts.action);
	}
	if (opts.user) {
		parts.push('username = ?');
		args.push(opts.user);
	}
	return { where: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args };
}

/** Lowercased search needle, or null when no q filter applies. */
function needle(q: string | undefined): string | null {
	const t = q?.trim().toLowerCase();
	if (!t) return null;
	return t;
}

function matches(e: AuditEntry, q: string): boolean {
	return (
		e.action.toLowerCase().includes(q) ||
		(e.username ?? '').toLowerCase().includes(q) ||
		(e.detail ?? '').toLowerCase().includes(q) ||
		(e.ip ?? '').toLowerCase().includes(q)
	);
}
