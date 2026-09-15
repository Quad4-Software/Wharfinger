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
}
