import type { DatabaseSync } from 'node:sqlite';
import type { Cookies } from '@sveltejs/kit';
import { SESSION_COOKIE } from '$lib/server/constants';
import { asDb, type Db } from '$lib/server/store/driver';
import { hashToken, randomToken } from './crypto';
import type { User, UserStore } from './users';

export interface SessionInfo {
	tokenHash: string;
	userId: number;
	createdAt: number;
	expiresAt: number;
	lastSeenAt: number;
	ip: string | null;
	userAgent: string | null;
	current?: boolean;
}

interface SessionRow {
	token_hash: string;
	user_id: number;
	created_at: number;
	expires_at: number;
	last_seen_at: number;
	ip: string | null;
	user_agent: string | null;
}

const SELECT =
	'SELECT token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent FROM sessions';

export class SessionStore {
	private readonly db: Db;

	constructor(
		db: Db | DatabaseSync,
		private readonly users: UserStore
	) {
		this.db = asDb(db);
	}

	async create(
		userId: number,
		ttlMs: number,
		ip: string | null,
		userAgent: string | null
	): Promise<string> {
		const token = randomToken();
		const now = Date.now();
		await this.db
			.prepare(
				'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)'
			)
			.run(hashToken(token), userId, now, now + ttlMs, now, ip, userAgent?.slice(0, 300) ?? null);
		return token;
	}

	/**
	 * Resolve a session cookie value to a live user. Sliding renewal:
	 * sessions past half their TTL get extended so active users are not
	 * logged out mid-work.
	 */
	async resolve(token: string, ttlMs: number): Promise<{ user: User; tokenHash: string } | null> {
		const tokenHash = hashToken(token);
		const row = (await this.db.prepare(`${SELECT} WHERE token_hash = ?`).get(tokenHash)) as
			SessionRow | undefined;
		if (!row) return null;
		const now = Date.now();
		if (row.expires_at <= now) {
			await this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
			return null;
		}
		const user = await this.users.byId(row.user_id);
		if (user?.disabledAt !== null) {
			await this.revokeUserSessions(row.user_id);
			return null;
		}
		if (row.expires_at - now < ttlMs / 2) {
			await this.db
				.prepare('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?')
				.run(now + ttlMs, now, tokenHash);
		} else {
			await this.db
				.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
				.run(now, tokenHash);
		}
		return { user, tokenHash };
	}

	async forUser(userId: number, currentHash?: string): Promise<SessionInfo[]> {
		const rows = (await this.db
			.prepare(`${SELECT} WHERE user_id = ? ORDER BY last_seen_at DESC`)
			.all(userId)) as unknown as SessionRow[];
		return rows.map((r) => ({
			tokenHash: r.token_hash,
			userId: r.user_id,
			createdAt: r.created_at,
			expiresAt: r.expires_at,
			lastSeenAt: r.last_seen_at,
			ip: r.ip,
			userAgent: r.user_agent,
			current: r.token_hash === currentHash
		}));
	}

	async revoke(tokenHash: string): Promise<void> {
		await this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
	}

	async revokeUserSessions(userId: number, exceptHash?: string): Promise<void> {
		if (exceptHash) {
			await this.db
				.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
				.run(userId, exceptHash);
		} else {
			await this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
		}
	}

	async prune(now = Date.now()): Promise<number> {
		return Number(
			(await this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)).changes
		);
	}
}

export function setSessionCookie(
	cookies: Cookies,
	token: string,
	ttlMs: number,
	secure: boolean
): void {
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure,
		maxAge: Math.floor(ttlMs / 1000)
	});
}

export function clearSessionCookie(cookies: Cookies): void {
	cookies.delete(SESSION_COOKIE, { path: '/' });
}
