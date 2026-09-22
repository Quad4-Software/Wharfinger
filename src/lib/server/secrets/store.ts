import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { asDb, isUniqueViolation, rawSqlite, type Db } from '$lib/server/store/driver';
import { openSecret, sealSecret } from '$lib/server/admin/crypto';
import type { SecretSetInfo, SecretSetVersionInfo } from '$lib/shared/groups';

export class SecretError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

const NAME_MAX = 64;
const MAX_KEYS = 128;
const MAX_VALUE_BYTES = 32 * 1024;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VERSION_CAP = 50;

const SET_COLS = 'id, name, sealed, updated_by, created_at, updated_at';

interface SetRow {
	id: string;
	name: string;
	sealed: string;
	updated_by: string | null;
	created_at: number;
	updated_at: number;
}

interface VersionRow {
	id: number;
	set_id: string;
	version: number;
	sealed: string;
	changed_keys: string;
	actor: string | null;
	created_at: number;
}

function validName(name: string): string {
	const n = name.trim();
	if (n.length < 1 || n.length > NAME_MAX) {
		throw new SecretError(422, 'name must be 1-64 characters');
	}
	return n;
}

function validEntries(entries: Record<string, string>): Record<string, string> {
	const keys = Object.keys(entries);
	if (keys.length > MAX_KEYS) throw new SecretError(422, 'too many keys');
	for (const k of keys) {
		if (!KEY_RE.test(k)) throw new SecretError(422, `invalid key name: ${k}`);
		const v = entries[k];
		if (typeof v !== 'string' || v.length > MAX_VALUE_BYTES) {
			throw new SecretError(422, `value too large for key: ${k}`);
		}
	}
	return entries;
}

/**
 * Key names that differ between two maps: added, removed, or with a
 * changed value. Only names are recorded, never the values compared.
 */
function diffKeys(prev: Record<string, string>, next: Record<string, string>): string[] {
	const changed: string[] = [];
	for (const k of Object.keys(next)) {
		if (!(k in prev) || prev[k] !== next[k]) changed.push(k);
	}
	for (const k of Object.keys(prev)) {
		if (!(k in next)) changed.push(k);
	}
	return changed.sort();
}

export class SecretSetStore {
	private readonly db: Db;

	constructor(db: Db | DatabaseSync) {
		this.db = asDb(db);
		// Lazy DDL is sqlite-only; surreal gets these tables from
		// store/schema.ts.
		const raw = rawSqlite(this.db);
		if (!raw) return;
		raw.exec(`
			CREATE TABLE IF NOT EXISTS secret_sets (
				id         TEXT PRIMARY KEY,
				name       TEXT NOT NULL UNIQUE,
				sealed     TEXT NOT NULL,
				updated_by TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS secret_set_versions (
				id           INTEGER PRIMARY KEY AUTOINCREMENT,
				set_id       TEXT NOT NULL REFERENCES secret_sets(id) ON DELETE CASCADE,
				version      INTEGER NOT NULL,
				sealed       TEXT NOT NULL,
				changed_keys TEXT NOT NULL,
				actor        TEXT,
				created_at   INTEGER NOT NULL
			);
			CREATE UNIQUE INDEX IF NOT EXISTS idx_secret_set_versions
				ON secret_set_versions (set_id, version);
		`);
		// Raw DatabaseSync handles skip db.ts migrate(); grow the
		// column here for databases created before it existed.
		const cols = (
			raw.prepare("SELECT name FROM pragma_table_info('secret_sets')").all() as {
				name: string;
			}[]
		).map((c) => c.name);
		if (!cols.includes('updated_by')) {
			raw.exec('ALTER TABLE secret_sets ADD COLUMN updated_by TEXT');
		}
	}

	/** Unseals the whole map; callers must never serialize it out. */
	private openMap(sealed: string): Record<string, string> {
		const plain = openSecret(sealed);
		if (plain === null) throw new SecretError(500, 'sealed secret set is unreadable');
		try {
			const v = JSON.parse(plain) as unknown;
			if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
			return v as Record<string, string>;
		} catch {
			return {};
		}
	}

	private toInfo(r: SetRow, keys: string[]): SecretSetInfo {
		return {
			id: r.id,
			name: r.name,
			keys,
			updatedBy: r.updated_by ?? null,
			createdAt: r.created_at,
			updatedAt: r.updated_at
		};
	}

	private async rowById(id: string, db: Db = this.db): Promise<SetRow | null> {
		return (
			((await db.prepare(`SELECT ${SET_COLS} FROM secret_sets WHERE id = ?`).get(id)) as
				SetRow | undefined) ?? null
		);
	}

	/**
	 * Append a version row for set id inside an existing transaction.
	 * sealed is the map the version restores to; changedKeys records
	 * names only. Versions past VERSION_CAP are pruned oldest-first.
	 */
	private async writeVersion(
		tx: Db,
		setId: string,
		sealed: string,
		changedKeys: string[],
		actor: string | null,
		at: number
	): Promise<void> {
		const prior = (await tx
			.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM secret_set_versions WHERE set_id = ?')
			.get(setId)) as { v: number } | undefined;
		await tx
			.prepare(
				'INSERT INTO secret_set_versions (set_id, version, sealed, changed_keys, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)'
			)
			.run(setId, (prior?.v ?? 0) + 1, sealed, JSON.stringify(changedKeys), actor, at);
		// Same bounded-tail pattern as markers.ts: keep the newest
		// VERSION_CAP rows per set.
		await tx
			.prepare(
				`DELETE FROM secret_set_versions WHERE set_id = ? AND id NOT IN (
					SELECT id FROM secret_set_versions WHERE set_id = ?
					ORDER BY version DESC LIMIT ${VERSION_CAP}
				)`
			)
			.run(setId, setId);
	}

	async create(
		name: string,
		entries: Record<string, string>,
		actor: string | null = null
	): Promise<SecretSetInfo> {
		const n = validName(name);
		const map = validEntries(entries);
		const id = `sec_${randomBytes(9).toString('base64url')}`;
		const now = Date.now();
		const sealed = sealSecret(JSON.stringify(map));
		try {
			await this.db.tx(async (tx) => {
				await tx
					.prepare(
						'INSERT INTO secret_sets (id, name, sealed, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
					)
					.run(id, n, sealed, actor, now, now);
				// Every key is new relative to an empty map.
				await this.writeVersion(tx, id, sealed, Object.keys(map).sort(), actor, now);
			});
		} catch (err) {
			if (isUniqueViolation(err)) {
				throw new SecretError(409, 'a set with that name exists');
			}
			throw err;
		}
		return {
			id,
			name: n,
			keys: Object.keys(map).sort(),
			updatedBy: actor,
			createdAt: now,
			updatedAt: now
		};
	}

	async list(): Promise<SecretSetInfo[]> {
		const rows = (await this.db
			.prepare(`SELECT ${SET_COLS} FROM secret_sets ORDER BY name`)
			.all()) as unknown as SetRow[];
		return rows.map((r) => this.toInfo(r, Object.keys(this.openMap(r.sealed)).sort()));
	}

	/** Metadata and key names only, never the values. */
	async get(id: string): Promise<SecretSetInfo | null> {
		const r = await this.rowById(id);
		if (!r) return null;
		return this.toInfo(r, Object.keys(this.openMap(r.sealed)).sort());
	}

	/**
	 * Replace the set: name when given, and the whole key->value map
	 * when entries is provided. There is no partial value update; the
	 * sealed blob is rewritten as a unit. Every write appends a
	 * version row, so restores can reach any prior state.
	 */
	async put(
		id: string,
		patch: { name?: string; entries?: Record<string, string> },
		actor: string | null = null
	): Promise<SecretSetInfo> {
		const newName = patch.name !== undefined ? validName(patch.name) : null;
		const newEntries = patch.entries !== undefined ? validEntries(patch.entries) : null;
		try {
			await this.db.tx(async (tx) => {
				const row = await this.rowById(id, tx);
				if (!row) throw new SecretError(404, 'secret set not found');
				const name = newName ?? row.name;
				const map = newEntries ?? this.openMap(row.sealed);
				const sealed = sealSecret(JSON.stringify(map));
				const now = Date.now();
				await tx
					.prepare(
						'UPDATE secret_sets SET name = ?, sealed = ?, updated_by = ?, updated_at = ? WHERE id = ?'
					)
					.run(name, sealed, actor, now, id);
				await this.writeVersion(
					tx,
					id,
					sealed,
					diffKeys(this.openMap(row.sealed), map),
					actor,
					now
				);
			});
		} catch (err) {
			if (isUniqueViolation(err)) {
				throw new SecretError(409, 'a set with that name exists');
			}
			throw err;
		}
		const info = await this.get(id);
		if (!info) throw new SecretError(500, 'secret set missing after update');
		return info;
	}

	/** Version metadata newest-first; key names only, never values. */
	async versions(id: string): Promise<SecretSetVersionInfo[]> {
		const rows = (await this.db
			.prepare(
				'SELECT version, changed_keys, actor, created_at FROM secret_set_versions WHERE set_id = ? ORDER BY version DESC'
			)
			.all(id)) as unknown as Pick<
			VersionRow,
			'version' | 'changed_keys' | 'actor' | 'created_at'
		>[];
		return rows.map((r) => {
			let changedKeys: string[] = [];
			try {
				const v = JSON.parse(r.changed_keys) as unknown;
				if (Array.isArray(v)) changedKeys = v.filter((k): k is string => typeof k === 'string');
			} catch {
				// A corrupt row still lists; it just shows no diff.
			}
			return { version: r.version, changedKeys, actor: r.actor ?? null, createdAt: r.created_at };
		});
	}

	/**
	 * The unsealed key->value map of one version. Server-internal;
	 * the result must never be serialized to a client.
	 */
	async versionEntries(id: string, version: number): Promise<Record<string, string> | null> {
		const row = (await this.db
			.prepare('SELECT sealed FROM secret_set_versions WHERE set_id = ? AND version = ?')
			.get(id, version)) as { sealed: string } | undefined;
		if (!row) return null;
		return this.openMap(row.sealed);
	}

	/**
	 * Reapply a prior version's map as a new write, so the restore
	 * itself is versioned and can be undone by restoring back.
	 */
	async restore(id: string, version: number, actor: string | null = null): Promise<SecretSetInfo> {
		if (!(await this.rowById(id))) throw new SecretError(404, 'secret set not found');
		const map = await this.versionEntries(id, version);
		if (map === null) throw new SecretError(404, 'version not found');
		return this.put(id, { entries: map }, actor);
	}

	async remove(id: string): Promise<boolean> {
		return this.db.tx(async (tx) => {
			// sqlite cascades via FK; surreal needs the explicit child
			// delete, so run it on both drivers.
			await tx.prepare('DELETE FROM secret_set_versions WHERE set_id = ?').run(id);
			const res = await tx.prepare('DELETE FROM secret_sets WHERE id = ?').run(id);
			return Number(res.changes) === 1;
		});
	}

	/** Single value for the reveal endpoint; null for missing set or key. */
	async reveal(id: string, key: string): Promise<string | null> {
		const row = await this.rowById(id);
		if (!row) return null;
		const map = this.openMap(row.sealed);
		const v = map[key];
		return typeof v === 'string' ? v : null;
	}
}

// Lazy singleton per the runtime-frozen store pattern: routes call
// getSecretStore(getRuntime().db).
const stores = new WeakMap<Db | DatabaseSync, SecretSetStore>();

export function getSecretStore(db: Db | DatabaseSync): SecretSetStore {
	const existing = stores.get(db);
	if (existing) return existing;
	const created = new SecretSetStore(db);
	stores.set(db, created);
	return created;
}

/**
 * Resolve a secret reference of the form secret:<set name or id>:<KEY>
 * to its plaintext value, or null when the reference is malformed, the
 * set is missing, or the key is absent. Intended for future consumers
 * (deploy env interpolation, job payloads) that need a single value at
 * dispatch time; callers must not log or serialize the result.
 */
export async function resolveSecret(db: Db | DatabaseSync, ref: string): Promise<string | null> {
	const m = /^secret:([^:]+):([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref);
	if (!m) return null;
	const [, setRef, key] = m;
	const row = (await asDb(db)
		.prepare('SELECT sealed FROM secret_sets WHERE id = ? OR name = ?')
		.get(setRef, setRef)) as { sealed: string } | undefined;
	if (!row) return null;
	const plain = openSecret(row.sealed);
	if (plain === null) return null;
	try {
		const map = JSON.parse(plain) as unknown;
		if (map === null || typeof map !== 'object' || Array.isArray(map)) return null;
		const v = (map as Record<string, unknown>)[key];
		return typeof v === 'string' ? v : null;
	} catch {
		return null;
	}
}
