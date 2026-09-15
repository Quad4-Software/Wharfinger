import type { DatabaseSync } from 'node:sqlite';
import { asDb, type Db } from '$lib/server/store/driver';
import { hashToken, randomToken } from './crypto';
import type { Role } from './users';

export type InviteKind = 'invite' | 'reset';

export interface Invite {
	tokenHash: string;
	kind: InviteKind;
	role: Role;
	userId: number | null;
	createdBy: number | null;
	createdAt: number;
	expiresAt: number;
	usedAt: number | null;
	revokedAt: number | null;
}

interface InviteRow {
	token_hash: string;
	kind: string;
	role: string;
	user_id: number | null;
	created_by: number | null;
	created_at: number;
	expires_at: number;
	used_at: number | null;
	revoked_at: number | null;
}

const SELECT =
	'SELECT token_hash, kind, role, user_id, created_by, created_at, expires_at, used_at, revoked_at FROM invites';

function toInvite(r: InviteRow): Invite {
	return {
		tokenHash: r.token_hash,
		kind: r.kind as InviteKind,
		role: r.role,
		userId: r.user_id,
		createdBy: r.created_by,
		createdAt: r.created_at,
		expiresAt: r.expires_at,
		usedAt: r.used_at,
		revokedAt: r.revoked_at
	};
}

export class InviteStore {
	private readonly db: Db;

	constructor(db: Db | DatabaseSync) {
		this.db = asDb(db);
	}

	async create(opts: {
		kind: InviteKind;
		role: Role;
		userId?: number;
		createdBy?: number;
		ttlMs: number;
	}): Promise<{ token: string; invite: Invite }> {
		const token = randomToken();
		const now = Date.now();
		await this.db
			.prepare(
				'INSERT INTO invites (token_hash, kind, role, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
			)
			.run(
				hashToken(token),
				opts.kind,
				opts.role,
				opts.userId ?? null,
				opts.createdBy ?? null,
				now,
				now + opts.ttlMs
			);
		const invite = await this.lookup(token);
		if (!invite) throw new Error('invite insert failed');
		return { token, invite };
	}

	async lookup(token: string): Promise<Invite | null> {
		const r = (await this.db.prepare(`${SELECT} WHERE token_hash = ?`).get(hashToken(token))) as
			InviteRow | undefined;
		return r ? toInvite(r) : null;
	}

	/** A token is usable when unexpired, unused, and unrevoked. */
	isUsable(inv: Invite, now = Date.now()): boolean {
		return inv.usedAt === null && inv.revokedAt === null && inv.expiresAt > now;
	}

	async markUsed(tokenHash: string, now = Date.now()): Promise<void> {
		await this.db
			.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ?')
			.run(now, tokenHash);
	}

	/**
	 * Atomically claim a usable invite. The conditional update is the
	 * single-use guarantee: two concurrent accepts race on the same row
	 * and only the first writer sees changes === 1.
	 */
	async tryClaim(tokenHash: string, now = Date.now()): Promise<boolean> {
		const r = await this.db
			.prepare(
				'UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?'
			)
			.run(now, tokenHash, now);
		return Number(r.changes) === 1;
	}

	async revoke(tokenHash: string): Promise<void> {
		await this.db
			.prepare('UPDATE invites SET revoked_at = ? WHERE token_hash = ? AND used_at IS NULL')
			.run(Date.now(), tokenHash);
	}

	/** Invalidate every outstanding link for a user (password resets). */
	async revokeForUser(userId: number): Promise<void> {
		await this.db
			.prepare('UPDATE invites SET revoked_at = ? WHERE user_id = ? AND used_at IS NULL')
			.run(Date.now(), userId);
	}

	async pending(limit = 100): Promise<Invite[]> {
		const rows = (await this.db
			.prepare(
				`${SELECT} WHERE used_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT ?`
			)
			.all(limit)) as unknown as InviteRow[];
		return rows.map(toInvite);
	}

	async recent(limit = 100): Promise<Invite[]> {
		const rows = (await this.db
			.prepare(`${SELECT} ORDER BY created_at DESC LIMIT ?`)
			.all(limit)) as unknown as InviteRow[];
		return rows.map(toInvite);
	}

	async prune(now = Date.now()): Promise<number> {
		return Number(
			(
				await this.db
					.prepare('DELETE FROM invites WHERE expires_at <= ? AND used_at IS NULL')
					.run(now)
			).changes
		);
	}
}
