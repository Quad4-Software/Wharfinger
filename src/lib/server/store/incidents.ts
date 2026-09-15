import type { DatabaseSync } from 'node:sqlite';
import { asDb, type Db } from './driver';

export interface IncidentRow {
	id: number;
	serviceId: string;
	severity: 'minor' | 'major';
	title: string;
	startedAt: number;
	endedAt: number | null;
}

const COLS =
	'id, service_id AS serviceId, severity, title, started_at AS startedAt, ended_at AS endedAt';

export class IncidentStore {
	private readonly db: Db;

	constructor(db: Db | DatabaseSync) {
		this.db = asDb(db);
	}

	async open(
		serviceId: string,
		severity: 'minor' | 'major',
		title: string,
		now = Date.now()
	): Promise<number> {
		const existing = await this.openFor(serviceId);
		if (existing) return existing.id;
		const r = await this.db
			.prepare(
				'INSERT INTO incidents (service_id, severity, title, started_at) VALUES (?, ?, ?, ?)'
			)
			.run(serviceId, severity, title, now);
		return Number(r.lastInsertRowid);
	}

	async close(serviceId: string, now = Date.now()): Promise<void> {
		await this.db
			.prepare('UPDATE incidents SET ended_at = ? WHERE service_id = ? AND ended_at IS NULL')
			.run(now, serviceId);
	}

	async openFor(serviceId: string): Promise<IncidentRow | null> {
		const row = (await this.db
			.prepare(
				`SELECT ${COLS} FROM incidents WHERE service_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`
			)
			.get(serviceId)) as IncidentRow | undefined;
		return row ?? null;
	}

	async allOpen(): Promise<IncidentRow[]> {
		return (await this.db
			.prepare(`SELECT ${COLS} FROM incidents WHERE ended_at IS NULL ORDER BY started_at DESC`)
			.all()) as unknown as IncidentRow[];
	}

	async recent(limit: number): Promise<IncidentRow[]> {
		return (await this.db
			.prepare(
				`SELECT ${COLS} FROM incidents WHERE ended_at IS NOT NULL ORDER BY started_at DESC LIMIT ?`
			)
			.all(limit)) as unknown as IncidentRow[];
	}

	async byId(id: number): Promise<IncidentRow | null> {
		const row = (await this.db.prepare(`SELECT ${COLS} FROM incidents WHERE id = ?`).get(id)) as
			IncidentRow | undefined;
		return row ?? null;
	}

	/** Manually close an open incident regardless of monitor state. */
	async resolve(id: number, now = Date.now()): Promise<boolean> {
		return (
			Number(
				(
					await this.db
						.prepare('UPDATE incidents SET ended_at = ? WHERE id = ? AND ended_at IS NULL')
						.run(now, id)
				).changes
			) > 0
		);
	}

	async addUpdate(
		incidentId: number,
		message: string,
		author: string | null,
		now = Date.now()
	): Promise<void> {
		await this.db
			.prepare(
				'INSERT INTO incident_updates (incident_id, at, message, author) VALUES (?, ?, ?, ?)'
			)
			.run(incidentId, now, message, author);
	}

	/** Operator-posted updates, keyed by incident row id. */
	async updatesFor(
		ids: number[]
	): Promise<Map<number, { at: number; message: string; author: string | null }[]>> {
		const out = new Map<number, { at: number; message: string; author: string | null }[]>();
		if (ids.length === 0) return out;
		const rows = (await this.db
			.prepare(
				`SELECT incident_id AS incidentId, at, message, author FROM incident_updates WHERE incident_id IN (${ids.map(() => '?').join(',')}) ORDER BY at DESC`
			)
			.all(...ids)) as unknown as {
			incidentId: number;
			at: number;
			message: string;
			author: string | null;
		}[];
		for (const r of rows) {
			const list = out.get(r.incidentId) ?? [];
			list.push({ at: r.at, message: r.message, author: r.author });
			out.set(r.incidentId, list);
		}
		return out;
	}
}
