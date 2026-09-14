import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openSecret, sealSecret } from '$lib/server/admin/crypto';
import type { SecretSetInfo } from '$lib/shared/groups';

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

interface SetRow {
	id: string;
	name: string;
	sealed: string;
	created_at: number;
	updated_at: number;
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

export class SecretSetStore {
	constructor(private readonly db: DatabaseSync) {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS secret_sets (
				id         TEXT PRIMARY KEY,
				name       TEXT NOT NULL UNIQUE,
				sealed     TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
		`);
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
			createdAt: r.created_at,
			updatedAt: r.updated_at
		};
	}

	private rowById(id: string): SetRow | null {
		return (
			(this.db
				.prepare('SELECT id, name, sealed, created_at, updated_at FROM secret_sets WHERE id = ?')
				.get(id) as SetRow | undefined) ?? null
		);
	}

	create(name: string, entries: Record<string, string>): SecretSetInfo {
		const n = validName(name);
		const map = validEntries(entries);
		const id = `sec_${randomBytes(9).toString('base64url')}`;
		const now = Date.now();
		try {
			this.db
				.prepare(
					'INSERT INTO secret_sets (id, name, sealed, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
				)
				.run(id, n, sealSecret(JSON.stringify(map)), now, now);
		} catch (err) {
			if (String(err).includes('UNIQUE')) {
				throw new SecretError(409, 'a set with that name exists');
			}
			throw err;
		}
		return { id, name: n, keys: Object.keys(map).sort(), createdAt: now, updatedAt: now };
	}

	list(): SecretSetInfo[] {
		const rows = this.db
			.prepare('SELECT id, name, sealed, created_at, updated_at FROM secret_sets ORDER BY name')
			.all() as unknown as SetRow[];
		return rows.map((r) => this.toInfo(r, Object.keys(this.openMap(r.sealed)).sort()));
	}

	/** Metadata and key names only, never the values. */
	get(id: string): SecretSetInfo | null {
		const r = this.rowById(id);
		if (!r) return null;
		return this.toInfo(r, Object.keys(this.openMap(r.sealed)).sort());
	}

	/**
	 * Replace the set: name when given, and the whole key->value map
	 * when entries is provided. There is no partial value update; the
	 * sealed blob is rewritten as a unit.
	 */
	put(id: string, patch: { name?: string; entries?: Record<string, string> }): SecretSetInfo {
		const row = this.rowById(id);
		if (!row) throw new SecretError(404, 'secret set not found');
		const name = patch.name !== undefined ? validName(patch.name) : row.name;
		const map =
			patch.entries !== undefined ? validEntries(patch.entries) : this.openMap(row.sealed);
		try {
			this.db
				.prepare('UPDATE secret_sets SET name = ?, sealed = ?, updated_at = ? WHERE id = ?')
				.run(name, sealSecret(JSON.stringify(map)), Date.now(), id);
		} catch (err) {
			if (String(err).includes('UNIQUE')) {
				throw new SecretError(409, 'a set with that name exists');
			}
			throw err;
		}
		const info = this.get(id);
		if (!info) throw new SecretError(500, 'secret set missing after update');
		return info;
	}

	remove(id: string): boolean {
		return Number(this.db.prepare('DELETE FROM secret_sets WHERE id = ?').run(id).changes) === 1;
	}

	/** Single value for the reveal endpoint; null for missing set or key. */
	reveal(id: string, key: string): string | null {
		const row = this.rowById(id);
		if (!row) return null;
		const map = this.openMap(row.sealed);
		const v = map[key];
		return typeof v === 'string' ? v : null;
	}
}

// Lazy singleton per the runtime-frozen store pattern: routes call
// getSecretStore(getRuntime().db).
const stores = new WeakMap<DatabaseSync, SecretSetStore>();

export function getSecretStore(db: DatabaseSync): SecretSetStore {
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
export function resolveSecret(db: DatabaseSync, ref: string): string | null {
	const m = /^secret:([^:]+):([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref);
	if (!m) return null;
	const [, setRef, key] = m;
	const row = db
		.prepare('SELECT sealed FROM secret_sets WHERE id = ? OR name = ?')
		.get(setRef, setRef) as { sealed: string } | undefined;
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
