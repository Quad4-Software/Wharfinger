import type { DatabaseSync } from 'node:sqlite';

export interface IncidentRow {
	id: number;
	serviceId: string;
	severity: 'minor' | 'major';
	title: string;
	startedAt: number;
	endedAt: number | null;
}

export class IncidentStore {
	constructor(private readonly db: DatabaseSync) {}

	open(serviceId: string, severity: 'minor' | 'major', title: string, now = Date.now()): number {
		const existing = this.openFor(serviceId);
		if (existing) return existing.id;
		const r = this.db
			.prepare(
				'INSERT INTO incidents (service_id, severity, title, started_at) VALUES (?, ?, ?, ?)'
			)
			.run(serviceId, severity, title, now);
		return Number(r.lastInsertRowid);
	}

	close(serviceId: string, now = Date.now()): void {
		this.db
			.prepare('UPDATE incidents SET ended_at = ? WHERE service_id = ? AND ended_at IS NULL')
			.run(now, serviceId);
	}

	openFor(serviceId: string): IncidentRow | null {
		return (
			(this.db
				.prepare(
					'SELECT id, service_id AS serviceId, severity, title, started_at AS startedAt, ended_at AS endedAt FROM incidents WHERE service_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1'
				)
				.get(serviceId) as IncidentRow | undefined) ?? null
		);
	}

	allOpen(): IncidentRow[] {
		return this.db
			.prepare(
				'SELECT id, service_id AS serviceId, severity, title, started_at AS startedAt, ended_at AS endedAt FROM incidents WHERE ended_at IS NULL ORDER BY started_at DESC'
			)
			.all() as unknown as IncidentRow[];
	}

	recent(limit: number): IncidentRow[] {
		return this.db
			.prepare(
				'SELECT id, service_id AS serviceId, severity, title, started_at AS startedAt, ended_at AS endedAt FROM incidents WHERE ended_at IS NOT NULL ORDER BY started_at DESC LIMIT ?'
			)
			.all(limit) as unknown as IncidentRow[];
	}

	byId(id: number): IncidentRow | null {
		return (
			(this.db
				.prepare(
					'SELECT id, service_id AS serviceId, severity, title, started_at AS startedAt, ended_at AS endedAt FROM incidents WHERE id = ?'
				)
				.get(id) as IncidentRow | undefined) ?? null
		);
	}

	/** Manually close an open incident regardless of monitor state. */
	resolve(id: number, now = Date.now()): boolean {
		return (
			Number(
				this.db
					.prepare('UPDATE incidents SET ended_at = ? WHERE id = ? AND ended_at IS NULL')
					.run(now, id).changes
			) > 0
		);
	}

	addUpdate(incidentId: number, message: string, author: string | null, now = Date.now()): void {
		this.db
			.prepare(
				'INSERT INTO incident_updates (incident_id, at, message, author) VALUES (?, ?, ?, ?)'
			)
			.run(incidentId, now, message, author);
	}

	/** Operator-posted updates, keyed by incident row id. */
	updatesFor(ids: number[]): Map<number, { at: number; message: string; author: string | null }[]> {
		const out = new Map<number, { at: number; message: string; author: string | null }[]>();
		if (ids.length === 0) return out;
		const rows = this.db
			.prepare(
				`SELECT incident_id AS incidentId, at, message, author FROM incident_updates WHERE incident_id IN (${ids.map(() => '?').join(',')}) ORDER BY at DESC`
			)
			.all(...ids) as unknown as {
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
