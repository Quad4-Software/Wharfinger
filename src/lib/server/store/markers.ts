import type { DatabaseSync } from 'node:sqlite';

// Deployment markers: vertical lines on charts and entries on the
// timeline. Sources are the admin API, automation (API keys), and
// auto-markers like new telemetry release values.

export type MarkerKind = 'deploy' | 'release' | 'config' | 'note';

export interface Marker {
	id: number;
	ts: number;
	title: string;
	kind: MarkerKind;
	source: string | null;
	service: string | null;
}

const KINDS: MarkerKind[] = ['deploy', 'release', 'config', 'note'];
const MAX_MARKERS = 5000;

export class MarkerStore {
	constructor(private readonly db: DatabaseSync) {}

	add(m: {
		ts?: number;
		title: string;
		kind?: MarkerKind;
		source?: string | null;
		service?: string | null;
	}): Marker {
		const kind = m.kind !== undefined && KINDS.includes(m.kind) ? m.kind : 'note';
		const now = Date.now();
		// Clamp future timestamps like telemetry does; a far-future
		// marker would pin at the head of every chart.
		const ts = Math.min(Math.round(m.ts ?? now), now + 60_000);
		const r = this.db
			.prepare('INSERT INTO markers (ts, title, kind, source, service) VALUES (?, ?, ?, ?, ?)')
			.run(ts, m.title.slice(0, 256), kind, m.source?.slice(0, 128) ?? null, m.service ?? null);
		return {
			id: Number(r.lastInsertRowid),
			ts,
			title: m.title.slice(0, 256),
			kind,
			source: m.source?.slice(0, 128) ?? null,
			service: m.service ?? null
		};
	}

	remove(id: number): boolean {
		return this.db.prepare('DELETE FROM markers WHERE id = ?').run(id).changes > 0;
	}

	/** Markers in [from, to], optionally filtered to a service or global. */
	between(from: number, to: number, service?: string | null): Marker[] {
		const svc = service ?? null;
		return this.db
			.prepare(
				`SELECT id, ts, title, kind, source, service FROM markers
				WHERE ts BETWEEN ? AND ? AND (? IS NULL OR service IS NULL OR service = ?)
				ORDER BY ts`
			)
			.all(from, to, svc, svc) as unknown as Marker[];
	}

	list(opts: { limit: number; offset?: number }): { entries: Marker[]; total: number } {
		const total = (this.db.prepare('SELECT COUNT(*) AS n FROM markers').get() as { n: number }).n;
		const entries = this.db
			.prepare(
				'SELECT id, ts, title, kind, source, service FROM markers ORDER BY ts DESC LIMIT ? OFFSET ?'
			)
			.all(opts.limit, opts.offset ?? 0) as unknown as Marker[];
		return { entries, total };
	}

	/** Distinct recent titles for dedupe of auto-markers (releases). */
	exists(title: string, since: number): boolean {
		return (
			this.db
				.prepare('SELECT 1 FROM markers WHERE title = ? AND ts >= ? LIMIT 1')
				.get(title, since) !== undefined
		);
	}

	prune(cutoff: number): void {
		this.db.prepare('DELETE FROM markers WHERE ts < ?').run(cutoff);
		this.db.exec(
			`DELETE FROM markers WHERE id NOT IN (SELECT id FROM markers ORDER BY ts DESC LIMIT ${MAX_MARKERS})`
		);
	}
}
