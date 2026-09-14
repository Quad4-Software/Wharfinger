import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// Public status-page webhook subscribers. A subscription is pending
// until the endpoint owner confirms via a token link delivered to the
// webhook itself (double opt-in: proves control of the URL). Every
// dispatch is HMAC-signed with the per-subscriber secret.

export interface Subscriber {
	id: number;
	url: string;
	services: string[];
	secret: string;
	confirmedAt: number | null;
	createdAt: number;
	disabledAt: number | null;
}

const MAX_SUBSCRIBERS = 500;
const hash = (s: string): string => createHash('sha256').update(s).digest('hex');

interface Row {
	id: number;
	url: string;
	services: string;
	secret: string;
	confirmHash: string | null;
	confirmedAt: number | null;
	createdAt: number;
	disabledAt: number | null;
}

const COLS =
	'id, url, services, secret, confirm_hash AS confirmHash, confirmed_at AS confirmedAt, created_at AS createdAt, disabled_at AS disabledAt';

const toSub = (r: Row): Subscriber => ({
	...r,
	services: JSON.parse(r.services) as string[]
});

export class SubscriberStore {
	constructor(private readonly db: DatabaseSync) {}

	/** Create a pending subscription; returns the raw confirm token. */
	create(url: string, services: string[]): { sub: Subscriber; confirmToken: string } | null {
		const count = (this.db.prepare('SELECT COUNT(*) AS n FROM subscribers').get() as { n: number })
			.n;
		if (count >= MAX_SUBSCRIBERS) return null;
		const confirmToken = randomBytes(24).toString('hex');
		const secret = randomBytes(24).toString('hex');
		this.db
			.prepare(
				`INSERT INTO subscribers (url, services, secret, confirm_hash, created_at)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT (url) DO UPDATE SET
					services = excluded.services,
					confirm_hash = excluded.confirm_hash,
					confirmed_at = NULL,
					disabled_at = NULL`
			)
			.run(url, JSON.stringify(services), secret, hash(confirmToken), Date.now());
		const sub = this.db
			.prepare(`SELECT ${COLS} FROM subscribers WHERE url = ?`)
			.get(url) as unknown as Row;
		return { sub: toSub(sub), confirmToken };
	}

	confirm(token: string): boolean {
		return (
			this.db
				.prepare(
					'UPDATE subscribers SET confirmed_at = ?, confirm_hash = NULL WHERE confirm_hash = ?'
				)
				.run(Date.now(), hash(token)).changes > 0
		);
	}

	/** Verify the unsubscribe token carried in each dispatch payload. */
	unsubscribe(id: number, token: string): boolean {
		const row = this.db.prepare(`SELECT ${COLS} FROM subscribers WHERE id = ?`).get(id) as
			Row | undefined;
		if (!row) return false;
		const sub = toSub(row);
		const want = Buffer.from(this.unsubToken(sub));
		const got = Buffer.from(token);
		if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
		this.db.prepare('UPDATE subscribers SET disabled_at = ? WHERE id = ?').run(Date.now(), id);
		return true;
	}

	/** Confirmed, live subscribers for a service transition. */
	active(serviceId: string | null): Subscriber[] {
		const rows = this.db
			.prepare(
				`SELECT ${COLS} FROM subscribers WHERE confirmed_at IS NOT NULL AND disabled_at IS NULL`
			)
			.all() as unknown as Row[];
		return rows
			.map(toSub)
			.filter(
				(s) => serviceId === null || s.services.includes('all') || s.services.includes(serviceId)
			);
	}

	list(): Subscriber[] {
		return (
			this.db.prepare(`SELECT ${COLS} FROM subscribers ORDER BY id`).all() as unknown as Row[]
		).map(toSub);
	}

	remove(id: number): boolean {
		return this.db.prepare('DELETE FROM subscribers WHERE id = ?').run(id).changes > 0;
	}

	/** Unsubscribe token embedded in every dispatch payload. */
	unsubToken(sub: Subscriber): string {
		return createHmac('sha256', sub.secret).update('unsub').digest('hex').slice(0, 32);
	}

	/** Per-subscriber dispatch signature header value. */
	signature(sub: Subscriber, body: string): string {
		return createHmac('sha256', sub.secret).update(body).digest('hex');
	}
}
