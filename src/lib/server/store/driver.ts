// Storage driver contract. Every store talks to Db, not to
// node:sqlite directly, so the hub can run on embedded SQLite
// (default, zero-dependency) or a remote SurrealDB for fleets that
// outgrow a single file. Statements are written in the portable
// SQLite-flavored subset documented in .agents/references/storage.md;
// the SurrealDB driver translates them at prepare() time.
import { DatabaseSync } from 'node:sqlite';

interface SqlObject {
	[k: string]: SqlValue;
}

export type SqlValue =
	null | string | number | bigint | boolean | Uint8Array | SqlValue[] | SqlObject;

export interface RunResult {
	changes: number | bigint;
	lastInsertRowid: number | bigint | string;
}

export type Row = Record<string, unknown>;

export interface Stmt {
	run(...params: SqlValue[]): Promise<RunResult>;
	get(...params: SqlValue[]): Promise<Row | undefined>;
	all(...params: SqlValue[]): Promise<Row[]>;
}

export interface Db {
	readonly kind: 'sqlite' | 'surreal';
	prepare(sql: string): Stmt;
	/** Multi-statement DDL/misc execution, no parameters. */
	exec(sql: string): Promise<void>;
	/**
	 * Runs fn inside a write transaction. SQLite maps to BEGIN
	 * IMMEDIATE; SurrealDB maps to an interactive txn on the same
	 * websocket. Statements issued through tx share the atomic unit.
	 */
	tx<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

/**
 * SQLite adapter over node:sqlite. The calls resolve immediately;
 * the Promise shape exists so SurrealDb can share the interface.
 */
export class SqliteDb implements Db {
	readonly kind = 'sqlite' as const;
	// One write transaction at a time per connection; independent
	// callers queue instead of interleaving BEGIN statements.
	private txQueue: Promise<unknown> = Promise.resolve();

	constructor(private readonly db: DatabaseSync) {}

	prepare(sql: string): Stmt {
		const stmt = this.db.prepare(sql);
		return {
			run: (...params) => Promise.resolve(stmt.run(...params.map(sqliteParam))),
			get: (...params) => Promise.resolve(stmt.get(...params.map(sqliteParam)) as Row | undefined),
			all: (...params) => Promise.resolve(stmt.all(...params.map(sqliteParam)) as Row[])
		};
	}

	exec(sql: string): Promise<void> {
		this.db.exec(sql);
		return Promise.resolve();
	}

	async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
		const run = this.txQueue.then(() => this.txInner(fn));
		this.txQueue = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	}

	private async txInner<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			const out = await fn(this);
			this.db.exec('COMMIT');
			return out;
		} catch (err) {
			this.db.exec('ROLLBACK');
			throw err;
		}
	}

	close(): Promise<void> {
		this.db.close();
		return Promise.resolve();
	}

	/** Escape hatch for the few migration paths that need DatabaseSync. */
	raw(): DatabaseSync {
		return this.db;
	}
}

/** node:sqlite rejects booleans and undefined; normalize to 0/1/null. */
function sqliteParam(v: SqlValue | undefined): never {
	if (typeof v === 'boolean') return (v ? 1 : 0) as never;
	if (v === undefined) return null as never;
	return v as never;
}

/** Accepts either driver or a raw DatabaseSync (tests, lazy stores). */
export function asDb(db: Db | DatabaseSync): Db {
	return db instanceof DatabaseSync ? new SqliteDb(db) : db;
}

/** Raw handle when the driver is sqlite, else null (lazy DDL path). */
export function rawSqlite(db: Db | DatabaseSync): DatabaseSync | null {
	if (db instanceof DatabaseSync) return db;
	if (db instanceof SqliteDb) return db.raw();
	return null;
}

/** Cross-driver uniqueness-violation test for error-based branches. */
export function isUniqueViolation(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return msg.includes('UNIQUE constraint failed') || msg.includes('already contains');
}
