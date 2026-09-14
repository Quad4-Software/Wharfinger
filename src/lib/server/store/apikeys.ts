import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// Scoped automation keys for the /api/v1 surface. Tokens are shown
// once at creation; only the sha256 hash is stored, same discipline
// as agent tokens.

export type ApiScope = 'read' | 'write';

export interface ApiKey {
	id: number;
	name: string;
	scopes: ApiScope[];
	createdBy: string | null;
	createdAt: number;
	lastUsed: number | null;
	disabledAt: number | null;
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

interface Row {
	id: number;
	name: string;
	scopes: string;
	createdBy: string | null;
	createdAt: number;
	lastUsed: number | null;
	disabledAt: number | null;
}

const COLS =
	'id, name, scopes, created_by AS createdBy, created_at AS createdAt, last_used AS lastUsed, disabled_at AS disabledAt';

const toKey = (r: Row): ApiKey => ({
	...r,
	scopes: r.scopes.split(',').filter((s): s is ApiScope => s === 'read' || s === 'write')
});

export class ApiKeyStore {
	constructor(private readonly db: DatabaseSync) {}

	create(
		name: string,
		scopes: ApiScope[],
		createdBy: string | null
	): { key: ApiKey; token: string } {
		const token = `qs_${randomBytes(24).toString('hex')}`;
		const r = this.db
			.prepare(
				'INSERT INTO api_keys (name, key_hash, scopes, created_by, created_at) VALUES (?, ?, ?, ?, ?)'
			)
			.run(name.slice(0, 128), hash(token), scopes.join(','), createdBy, Date.now());
		return {
			key: {
				id: Number(r.lastInsertRowid),
				name: name.slice(0, 128),
				scopes,
				createdBy,
				createdAt: Date.now(),
				lastUsed: null,
				disabledAt: null
			},
			token
		};
	}

	/** Resolve a live key by its raw token; null when unknown/disabled. */
	resolve(token: string): ApiKey | null {
		if (!/^qs_[0-9a-f]{48}$/.test(token)) return null;
		const r = this.db
			.prepare(`SELECT ${COLS} FROM api_keys WHERE key_hash = ?`)
			.get(hash(token)) as Row | undefined;
		if (r?.disabledAt !== null) return null;
		return toKey(r);
	}

	/** Throttled last-used stamp: at most one write per minute per key. */
	touch(id: number): void {
		this.db
			.prepare(
				'UPDATE api_keys SET last_used = ? WHERE id = ? AND (last_used IS NULL OR last_used < ?)'
			)
			.run(Date.now(), id, Date.now() - 60_000);
	}

	list(): ApiKey[] {
		return (
			this.db.prepare(`SELECT ${COLS} FROM api_keys ORDER BY id`).all() as unknown as Row[]
		).map(toKey);
	}

	setDisabled(id: number, disabled: boolean): boolean {
		return (
			this.db
				.prepare('UPDATE api_keys SET disabled_at = ? WHERE id = ?')
				.run(disabled ? Date.now() : null, id).changes > 0
		);
	}

	remove(id: number): boolean {
		return this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id).changes > 0;
	}
}
