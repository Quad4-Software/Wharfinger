import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { hubSecret } from '$lib/server/ingress/keys';
import { asDb, type Db } from './driver';

// Dead-man's-switch beats: each push service owns a derived token URL.
// Beats are one row per service, so the table cannot grow unbounded.

export interface PushBeat {
	serviceId: string;
	lastBeat: number;
	beats: number;
	lastMsg: string | null;
}

export class PushStore {
	private readonly db: Db;

	constructor(db: Db | DatabaseSync) {
		this.db = asDb(db);
	}

	async beat(serviceId: string, msg: string | null): Promise<void> {
		await this.db
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

	async lastBeat(serviceId: string): Promise<number | null> {
		const r = (await this.db
			.prepare('SELECT last_beat AS lastBeat FROM push_beats WHERE service_id = ?')
			.get(serviceId)) as { lastBeat: number } | undefined;
		return r?.lastBeat ?? null;
	}

	async info(serviceId: string): Promise<PushBeat | null> {
		const r = (await this.db
			.prepare(
				'SELECT service_id AS serviceId, last_beat AS lastBeat, beats, last_msg AS lastMsg FROM push_beats WHERE service_id = ?'
			)
			.get(serviceId)) as PushBeat | undefined;
		return r ?? null;
	}

	/** Beats for services that no longer exist. */
	async prune(validIds: string[]): Promise<void> {
		if (validIds.length === 0) {
			await this.db.exec('DELETE FROM push_beats');
			return;
		}
		const marks = validIds.map(() => '?').join(',');
		await this.db
			.prepare(`DELETE FROM push_beats WHERE service_id NOT IN (${marks})`)
			.run(...validIds);
	}
}

/**
 * Deterministic per-service check-in token, HMACed under the hub
 * private key so URLs survive restarts but cannot be guessed from the
 * service id. 32 hex chars.
 */
export async function pushToken(db: Db | DatabaseSync, serviceId: string): Promise<string> {
	return createHmac('sha256', await hubSecret(db))
		.update(`push:${serviceId}`)
		.digest('hex')
		.slice(0, 32);
}

/** Constant-time token match against a candidate string. */
export async function tokenMatches(
	db: Db | DatabaseSync,
	serviceId: string,
	candidate: string
): Promise<boolean> {
	const want = Buffer.from(await pushToken(db, serviceId), 'utf8');
	const got = Buffer.from(candidate, 'utf8');
	return want.length === got.length && timingSafeEqual(want, got);
}
