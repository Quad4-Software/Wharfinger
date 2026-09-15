// SurrealDB storage driver. Speaks JSON-RPC over a single persistent
// WebSocket to /rpc so bound params stay typed and interactive
// transactions work via the top-level txn field. The connection is
// lazy: the first statement opens it, so getRuntime() stays
// synchronous and the hub boots identically on either driver.
import { translate, SqlDialectError } from './surrealql';
import { TABLE_META, surrealSchema } from './schema';
import type { Db, Row, RunResult, SqlValue, Stmt } from './driver';

export interface SurrealConfig {
	/** ws:// or wss:// URL; http(s):// is mapped onto ws(s). */
	url: string;
	ns: string;
	db: string;
	user: string;
	pass: string;
	/** per-request timeout, default 30s */
	timeoutMs?: number;
}

interface RpcResult {
	status?: string;
	result?: unknown;
}

export class SurrealDb implements Db {
	readonly kind = 'surreal' as const;

	private ws: WebSocket | null = null;
	private ready: Promise<void> | null = null;
	private nextId = 1;
	private pending = new Map<
		number,
		{ ok: (v: unknown) => void; bad: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();
	private inTx = false;

	constructor(private readonly cfg: SurrealConfig) {}

	private endpoint(): string {
		const u = new URL(this.cfg.url);
		if (u.protocol === 'http:') u.protocol = 'ws:';
		if (u.protocol === 'https:') u.protocol = 'wss:';
		if (!u.pathname.endsWith('/rpc')) u.pathname = u.pathname.replace(/\/?$/, '/rpc');
		return u.toString();
	}

	private ensure(): Promise<void> {
		if (this.ready) return this.ready;
		this.ready = this.connect().catch((err: unknown) => {
			this.ready = null;
			throw err;
		});
		return this.ready;
	}

	private async connect(): Promise<void> {
		const ws = new WebSocket(this.endpoint());
		this.ws = ws;
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => {
				resolve();
			};
			ws.onerror = () => {
				reject(new Error(`surrealdb connect failed: ${this.cfg.url}`));
			};
		});
		ws.onmessage = (ev) => {
			this.onMessage(String(ev.data));
		};
		ws.onclose = () => {
			this.ws = null;
			this.ready = null;
			for (const [, p] of this.pending) {
				clearTimeout(p.timer);
				p.bad(new Error('surrealdb connection closed'));
			}
			this.pending.clear();
		};
		await this.rpc('signin', [{ user: this.cfg.user, pass: this.cfg.pass }]);
		await this.rpc('use', [this.cfg.ns, this.cfg.db]);
		await this.rpc('query', [surrealSchema()]);
	}

	private onMessage(data: string): void {
		let msg: { id?: number; result?: unknown; error?: { message?: string } };
		try {
			msg = JSON.parse(data) as typeof msg;
		} catch {
			return;
		}
		if (msg.id === undefined) return;
		const p = this.pending.get(msg.id);
		if (!p) return;
		this.pending.delete(msg.id);
		clearTimeout(p.timer);
		if (msg.error) p.bad(new Error(`surrealdb: ${msg.error.message ?? 'rpc error'}`));
		else p.ok(msg.result);
	}

	private rpc(method: string, params: unknown[], txn?: string): Promise<unknown> {
		const ws = this.ws;
		if (!ws || ws.readyState !== ws.OPEN)
			return Promise.reject(new Error('surrealdb not connected'));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`surrealdb ${method} timed out`));
			}, this.cfg.timeoutMs ?? 30_000);
			this.pending.set(id, { ok: resolve, bad: reject, timer });
			const frame: Record<string, unknown> = { id, method, params };
			if (txn) frame.txn = txn;
			ws.send(JSON.stringify(frame));
		});
	}

	/** Runs SurrealQL and returns each statement's result. */
	async query(surql: string, vars: Record<string, unknown> = {}, txn?: string): Promise<unknown[]> {
		await this.ensure();
		const res = (await this.rpc('query', [surql, vars], txn)) as
			RpcResult[] | { result?: RpcResult[] };
		// v3 wraps query results in { result: [...] } on WS
		const arr = Array.isArray(res) ? res : (res.result ?? []);
		for (const r of arr) {
			if (r.status === 'ERR') throw new Error(`surrealdb query: ${JSON.stringify(r.result)}`);
		}
		return arr.map((r) => r.result);
	}

	prepare(sql: string): Stmt {
		const t = translate(sql, TABLE_META);
		const exec = async (params: SqlValue[], txn?: string): Promise<unknown> => {
			const vars: Record<string, unknown> = {};
			params.forEach((p, i) => {
				vars[`p${i}`] = normParam(p);
			});
			const results = await this.query(t.surql, vars, txn);
			return results[results.length - 1];
		};
		return this.stmt(exec);
	}

	protected stmt(exec: (params: SqlValue[], txn?: string) => Promise<unknown>): Stmt {
		const txn = this.txnScope;
		return {
			run: async (...params) => {
				const res = await exec(params, txn);
				return toRunResult(res);
			},
			get: async (...params) => {
				const res = await exec(params, txn);
				const rows = toRows(res);
				return rows[0];
			},
			all: async (...params) => {
				const res = await exec(params, txn);
				return toRows(res);
			}
		};
	}

	private txnScope: string | undefined;

	async exec(sql: string): Promise<void> {
		const stmts = splitStatements(sql).map((s) => translate(s, TABLE_META).surql);
		if (stmts.length === 0) return;
		await this.query(stmts.join(';\n'), {}, this.txnScope);
	}

	// One interactive transaction at a time on the shared socket;
	// independent callers queue instead of colliding on inTx.
	private txQueue: Promise<unknown> = Promise.resolve();

	async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
		const run = this.txQueue.then(() => this.txInner(fn));
		this.txQueue = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	}

	private async txInner<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
		if (this.inTx) throw new Error('nested transactions not supported');
		await this.ensure();
		this.inTx = true;
		try {
			const txn = (await this.rpc('begin', [])) as string;
			const txDb = new TxDb(this, txn);
			try {
				const out = await fn(txDb);
				await this.rpc('commit', [txn]);
				return out;
			} catch (err) {
				try {
					await this.rpc('cancel', [txn]);
				} catch {
					// connection may be gone; the txn dies with it
				}
				throw err;
			}
		} finally {
			this.inTx = false;
		}
	}

	/** Internal: run surql inside a live transaction. */
	txQuery(surql: string, vars: Record<string, unknown>, txn: string): Promise<unknown[]> {
		return this.query(surql, vars, txn);
	}

	close(): Promise<void> {
		this.ws?.close();
		this.ws = null;
		this.ready = null;
		return Promise.resolve();
	}
}

/** Db view bound to one live transaction. */
class TxDb implements Db {
	readonly kind = 'surreal' as const;

	constructor(
		private readonly inner: SurrealDb,
		private readonly txn: string
	) {}

	prepare(sql: string): Stmt {
		const t = translate(sql, TABLE_META);
		const exec = async (params: SqlValue[]): Promise<unknown> => {
			const vars: Record<string, unknown> = {};
			params.forEach((p, i) => {
				vars[`p${i}`] = normParam(p);
			});
			const results = await this.inner.txQuery(t.surql, vars, this.txn);
			return results[results.length - 1];
		};
		return {
			run: async (...params) => toRunResult(await exec(params)),
			get: async (...params) => toRows(await exec(params))[0],
			all: async (...params) => toRows(await exec(params))
		};
	}

	async exec(sql: string): Promise<void> {
		const stmts = splitStatements(sql).map((s) => translate(s, TABLE_META).surql);
		if (stmts.length) await this.inner.txQuery(stmts.join(';\n'), {}, this.txn);
	}

	tx<T>(): Promise<T> {
		return Promise.reject(new Error('nested transactions not supported'));
	}

	close(): Promise<void> {
		return Promise.resolve();
	}
}

/** Normalizes a bound value for the JSON-RPC wire. */
function normParam(v: SqlValue | undefined): unknown {
	if (v === undefined || v === null) return null;
	if (typeof v === 'boolean') return v ? 1 : 0;
	if (typeof v === 'bigint') {
		if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER))
			throw new SqlDialectError('bigint param out of range');
		return Number(v);
	}
	if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
	if (Array.isArray(v)) return v.map((x) => normParam(x));
	if (typeof v === 'object') {
		const o: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) o[k] = normParam(x);
		return o;
	}
	return v;
}

/** Parses a record id "t:v" back to the raw key (number, string, array). */
function parseRecordId(v: string): unknown {
	const i = v.indexOf(':');
	if (i < 0) return v;
	let inner = v.slice(i + 1);
	if (inner.startsWith('⟨') && inner.endsWith('⟩')) inner = inner.slice(1, -1);
	if (inner.startsWith('[')) {
		try {
			return JSON.parse(inner) as unknown;
		} catch {
			return inner;
		}
	}
	if (/^-?[0-9]+$/.test(inner)) return Number(inner);
	return inner;
}

/** Converts a SurrealDB row (id: "t:5") into a sqlite-shaped row (id: 5). */
function mapRow(row: unknown): Row {
	if (row === null || typeof row !== 'object' || Array.isArray(row)) return { value: row };
	const o = row as Record<string, unknown>;
	const out: Row = {};
	for (const [k, v] of Object.entries(o)) {
		out[k] = k === 'id' && typeof v === 'string' ? parseRecordId(v) : v;
	}
	return out;
}

function toRows(res: unknown): Row[] {
	if (res === null || res === undefined) return [];
	if (Array.isArray(res)) return res.map(mapRow);
	if (typeof res === 'object') return [mapRow(res)];
	// scalar results (RETURN VALUE) surface as {value}
	return [{ value: res }];
}

function toRunResult(res: unknown): RunResult {
	if (res === null || res === undefined) return { changes: 0, lastInsertRowid: 0 };
	if (Array.isArray(res)) {
		const last: unknown = res[res.length - 1];
		const parsed =
			typeof last === 'string' && last.includes(':')
				? parseRecordId(last)
				: typeof last === 'object' && last !== null
					? parseRecordId(String((last as Record<string, unknown>).id))
					: 0;
		const rowid = typeof parsed === 'number' || typeof parsed === 'string' ? parsed : 0;
		return { changes: res.length, lastInsertRowid: rowid };
	}
	if (typeof res === 'object') {
		const id = (res as Record<string, unknown>).id;
		return {
			changes: 1,
			lastInsertRowid: typeof id === 'string' ? (parseRecordId(id) as number | string) : 0
		};
	}
	return { changes: 1, lastInsertRowid: 0 };
}

/** Splits multi-statement sql on top-level semicolons, honoring quotes. */
function splitStatements(sql: string): string[] {
	const out: string[] = [];
	let cur = '';
	let i = 0;
	while (i < sql.length) {
		const c = sql[i];
		if (c === "'") {
			let j = i + 1;
			while (j < sql.length && sql[j] !== "'") j++;
			cur += sql.slice(i, j + 1);
			i = j + 1;
			continue;
		}
		if (c === '-' && sql[i + 1] === '-') {
			while (i < sql.length && sql[i] !== '\n') i++;
			continue;
		}
		if (c === ';') {
			if (cur.trim()) out.push(cur);
			cur = '';
			i++;
			continue;
		}
		cur += c;
		i++;
	}
	if (cur.trim()) out.push(cur);
	return out;
}
