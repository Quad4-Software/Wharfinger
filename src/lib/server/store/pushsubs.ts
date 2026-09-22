import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { asDb, type Db } from './driver';

// Browser Web Push subscriptions. The endpoint URL is the credential
// a push service issued to one browser install; it is stored verbatim
// (unique) because the sender must post to it. Rows bound to a panel
// user carry user_id; anonymous status-page subscriptions keep null.
// dead subs (push service reports 404/410) get disabled_at set and are
// swept by prune() together with stale rows.

export interface PushSub {
	id: string;
	endpoint: string;
	p256dh: string | null;
	auth: string | null;
	userId: number | null;
	userAgent: string | null;
	createdAt: number;
	lastSeenAt: number;
	disabledAt: number | null;
}

const MAX_SUBS = 2000;

const COLS =
	'id, endpoint, p256dh, auth, user_id AS userId, user_agent AS userAgent, created_at AS createdAt, last_seen_at AS lastSeenAt, disabled_at AS disabledAt';

export class PushSubStore {
	private readonly db: Db;

	constructor(db: Db | DatabaseSync) {
		this.db = asDb(db);
	}

	/**
	 * Register or refresh a subscription. endpoint is a secondary
	 * unique, not the record key, so the upsert ports as
	 * update-then-insert inside one transaction (same shape as
	 * SubscriberStore.create). A resubscribe re-enables a disabled row
	 * and rebinds ownership to the caller's session user.
	 */
	add(input: {
		endpoint: string;
		p256dh: string;
		auth: string;
		userId: number | null;
		userAgent: string | null;
	}): Promise<PushSub | null> {
		return this.db.tx(async (tx) => {
			const now = Date.now();
			const upd = await tx
				.prepare(
					`UPDATE push_subscriptions
					SET p256dh = ?, auth = ?, user_id = ?, user_agent = ?, last_seen_at = ?, disabled_at = NULL
					WHERE endpoint = ?`
				)
				.run(input.p256dh, input.auth, input.userId, input.userAgent, now, input.endpoint);
			if (Number(upd.changes) === 0) {
				const count = (
					(await tx.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()) as {
						n: number;
					}
				).n;
				if (count >= MAX_SUBS) return null;
				// INSERT OR IGNORE covers the secondary-unique race the
				// portable subset cannot express as ON CONFLICT.
				await tx
					.prepare(
						`INSERT OR IGNORE INTO push_subscriptions
						(id, endpoint, p256dh, auth, user_id, user_agent, created_at, last_seen_at)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.run(
						randomBytes(12).toString('hex'),
						input.endpoint,
						input.p256dh,
						input.auth,
						input.userId,
						input.userAgent,
						now,
						now
					);
			}
			return (await tx
				.prepare(`SELECT ${COLS} FROM push_subscriptions WHERE endpoint = ?`)
				.get(input.endpoint)) as unknown as PushSub;
		});
	}

	async remove(endpoint: string): Promise<boolean> {
		return (
			Number(
				(await this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint))
					.changes
			) > 0
		);
	}

	/** Revoke one subscription owned by the calling panel user. */
	async removeForUser(id: string, userId: number): Promise<boolean> {
		return (
			Number(
				(
					await this.db
						.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?')
						.run(id, userId)
				).changes
			) > 0
		);
	}

	async markSeen(endpoint: string): Promise<void> {
		await this.db
			.prepare('UPDATE push_subscriptions SET last_seen_at = ? WHERE endpoint = ?')
			.run(Date.now(), endpoint);
	}

	/** Tombstone a dead endpoint after the push service says Gone. */
	async disable(id: string): Promise<void> {
		await this.db
			.prepare('UPDATE push_subscriptions SET disabled_at = ? WHERE id = ?')
			.run(Date.now(), id);
	}

	/** Live subscriptions for one panel user. */
	async listForUser(userId: number): Promise<PushSub[]> {
		return (await this.db
			.prepare(`SELECT ${COLS} FROM push_subscriptions WHERE user_id = ? ORDER BY created_at`)
			.all(userId)) as unknown as PushSub[];
	}

	/** Every live subscription; the dispatcher fans alerts to all. */
	async active(): Promise<PushSub[]> {
		return (await this.db
			.prepare(`SELECT ${COLS} FROM push_subscriptions WHERE disabled_at IS NULL`)
			.all()) as unknown as PushSub[];
	}

	/** Drop tombstoned subs and live rows idle past the cutoff. */
	async prune(staleBefore: number): Promise<void> {
		await this.db
			.prepare('DELETE FROM push_subscriptions WHERE disabled_at IS NOT NULL OR last_seen_at < ?')
			.run(staleBefore);
	}
}
