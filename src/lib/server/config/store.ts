import type { DatabaseSync } from 'node:sqlite';
import { asDb, type Db } from '$lib/server/store/driver';
import type { SectionKey } from './schema';

export interface SectionOverride {
	section: string;
	raw: unknown;
	updatedBy: string | null;
	updatedAt: number;
}

/**
 * Runtime config overrides, one row per top-level config section.
 * Values are stored as the raw (pre-interpolation) JSON so ${VAR}
 * placeholders are preserved and secrets never persist resolved.
 */
export class ConfigStore {
	private readonly db: Db;

	constructor(db: Db | DatabaseSync) {
		this.db = asDb(db);
	}

	async all(): Promise<SectionOverride[]> {
		const rows = (await this.db
			.prepare(
				'SELECT section, raw_json, updated_by AS updatedBy, updated_at AS updatedAt FROM config_sections'
			)
			.all()) as unknown as {
			section: string;
			raw_json: string;
			updatedBy: string | null;
			updatedAt: number;
		}[];
		return rows.map((r) => ({
			section: r.section,
			raw: JSON.parse(r.raw_json) as unknown,
			updatedBy: r.updatedBy,
			updatedAt: r.updatedAt
		}));
	}

	async get(section: SectionKey): Promise<SectionOverride | null> {
		const r = (await this.db
			.prepare(
				'SELECT section, raw_json, updated_by AS updatedBy, updated_at AS updatedAt FROM config_sections WHERE section = ?'
			)
			.get(section)) as
			| { section: string; raw_json: string; updatedBy: string | null; updatedAt: number }
			| undefined;
		if (!r) return null;
		return {
			section: r.section,
			raw: JSON.parse(r.raw_json) as unknown,
			updatedBy: r.updatedBy,
			updatedAt: r.updatedAt
		};
	}

	async set(
		section: SectionKey,
		raw: unknown,
		updatedBy: string | null,
		now = Date.now()
	): Promise<void> {
		// section is the record key, so ON CONFLICT upsert is portable.
		await this.db
			.prepare(
				`INSERT INTO config_sections (section, raw_json, updated_by, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(section) DO UPDATE SET raw_json = excluded.raw_json,
				   updated_by = excluded.updated_by, updated_at = excluded.updated_at`
			)
			.run(section, JSON.stringify(raw), updatedBy, now);
	}

	async clear(section: SectionKey): Promise<void> {
		await this.db.prepare('DELETE FROM config_sections WHERE section = ?').run(section);
	}

	async clearAll(): Promise<void> {
		await this.db.exec('DELETE FROM config_sections');
	}

	// Saved TOML document revisions for the config editor. doc is the
	// exact text that was applied, so a restore is a round-trip through
	// the same validation path.
	async recordRevision(doc: string, author: string | null, now = Date.now()): Promise<void> {
		await this.db
			.prepare('INSERT INTO config_history (doc, author, at) VALUES (?, ?, ?)')
			.run(doc, author, now);
		// Keep the newest CONFIG_HISTORY_MAX rows.
		const keep = (await this.db
			.prepare('SELECT id FROM config_history ORDER BY id DESC LIMIT ?')
			.all(CONFIG_HISTORY_MAX)) as unknown as { id: number }[];
		if (keep.length === 0) return;
		await this.db
			.prepare(`DELETE FROM config_history WHERE id NOT IN (${keep.map(() => '?').join(',')})`)
			.run(...keep.map((k) => k.id));
	}

	async revisions(limit = 20): Promise<{ id: number; author: string | null; at: number }[]> {
		return (await this.db
			.prepare('SELECT id, author, at FROM config_history ORDER BY id DESC LIMIT ?')
			.all(limit)) as unknown as { id: number; author: string | null; at: number }[];
	}

	async revision(
		id: number
	): Promise<{ id: number; doc: string; author: string | null; at: number } | null> {
		const r = (await this.db
			.prepare('SELECT id, doc, author, at FROM config_history WHERE id = ?')
			.get(id)) as { id: number; doc: string; author: string | null; at: number } | undefined;
		return r ?? null;
	}
}

const CONFIG_HISTORY_MAX = 100;
