import type { DatabaseSync } from 'node:sqlite';
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
	constructor(private readonly db: DatabaseSync) {}

	all(): SectionOverride[] {
		const rows = this.db
			.prepare(
				'SELECT section, raw_json, updated_by AS updatedBy, updated_at AS updatedAt FROM config_sections'
			)
			.all() as unknown as {
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

	get(section: SectionKey): SectionOverride | null {
		const r = this.db
			.prepare(
				'SELECT section, raw_json, updated_by AS updatedBy, updated_at AS updatedAt FROM config_sections WHERE section = ?'
			)
			.get(section) as
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

	set(section: SectionKey, raw: unknown, updatedBy: string | null, now = Date.now()): void {
		this.db
			.prepare(
				`INSERT INTO config_sections (section, raw_json, updated_by, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(section) DO UPDATE SET raw_json = excluded.raw_json,
				   updated_by = excluded.updated_by, updated_at = excluded.updated_at`
			)
			.run(section, JSON.stringify(raw), updatedBy, now);
	}

	clear(section: SectionKey): void {
		this.db.prepare('DELETE FROM config_sections WHERE section = ?').run(section);
	}

	clearAll(): void {
		this.db.exec('DELETE FROM config_sections');
	}
}
