import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { hubSecret } from '$lib/server/ingress/keys';

// Dead-man's-switch beats: each push service owns a derived token URL.
// Beats are one row per service, so the table cannot grow unbounded.

export interface PushBeat {
	serviceId: string;
	lastBeat: number;
	beats: number;
	lastMsg: string | null;
}

export class PushStore {
	constructor(private readonly db: DatabaseSync) {}

	beat(serviceId: string, msg: string | null): void {
		this.db
			.prepare(
				`INSERT INTO push_beats (service_id, last_beat, beats, last_msg)
				VALUES (?, ?, 1, ?)
				ON CONFLICT (service_id) DO UPDATE SET
					last_beat = excluded.last_beat,
					beats = beats + 1,
					last_msg = excluded.last_msg`
			)
			.run(serviceId, Date.now(), msg);
	}

	lastBeat(serviceId: string): number | null {
		const r = this.db
			.prepare('SELECT last_beat AS lastBeat FROM push_beats WHERE service_id = ?')
			.get(serviceId) as { lastBeat: number } | undefined;
		return r?.lastBeat ?? null;
	}

	info(serviceId: string): PushBeat | null {
		const r = this.db
			.prepare(
				'SELECT service_id AS serviceId, last_beat AS lastBeat, beats, last_msg AS lastMsg FROM push_beats WHERE service_id = ?'
			)
			.get(serviceId) as PushBeat | undefined;
		return r ?? null;
	}

	/** Beats for services that no longer exist. */
	prune(validIds: string[]): void {
		if (validIds.length === 0) {
			this.db.exec('DELETE FROM push_beats');
			return;
		}
		const marks = validIds.map(() => '?').join(',');
		this.db.prepare(`DELETE FROM push_beats WHERE service_id NOT IN (${marks})`).run(...validIds);
	}
}

/**
 * Deterministic per-service check-in token, HMACed under the hub
 * private key so URLs survive restarts but cannot be guessed from the
 * service id. 32 hex chars.
 */
export function pushToken(db: DatabaseSync, serviceId: string): string {
	return createHmac('sha256', hubSecret(db)).update(`push:${serviceId}`).digest('hex').slice(0, 32);
}

/** Constant-time token match against a candidate string. */
export function tokenMatches(db: DatabaseSync, serviceId: string, candidate: string): boolean {
	const want = Buffer.from(pushToken(db, serviceId), 'utf8');
	const got = Buffer.from(candidate, 'utf8');
	return want.length === got.length && timingSafeEqual(want, got);
}
