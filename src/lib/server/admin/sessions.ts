import type { DatabaseSync } from 'node:sqlite';
import type { Cookies } from '@sveltejs/kit';
import { SESSION_COOKIE } from '$lib/server/constants';
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

export class SessionStore {
	constructor(
		private readonly db: DatabaseSync,
		private readonly users: UserStore
	) {}

	create(userId: number, ttlMs: number, ip: string | null, userAgent: string | null): string {
		const token = randomToken();
		const now = Date.now();
		this.db
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
	resolve(token: string, ttlMs: number): { user: User; tokenHash: string } | null {
		const tokenHash = hashToken(token);
		const row = this.db
			.prepare(
				'SELECT token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent FROM sessions WHERE token_hash = ?'
			)
			.get(tokenHash) as SessionRow | undefined;
		if (!row) return null;
		const now = Date.now();
		if (row.expires_at <= now) {
			this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
			return null;
		}
		const user = this.users.byId(row.user_id);
		if (user?.disabledAt !== null) {
			this.revokeUserSessions(row.user_id);
			return null;
		}
		if (row.expires_at - now < ttlMs / 2) {
			this.db
				.prepare('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?')
				.run(now + ttlMs, now, tokenHash);
		} else {
			this.db
				.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
				.run(now, tokenHash);
		}
		return { user, tokenHash };
	}

	forUser(userId: number, currentHash?: string): SessionInfo[] {
		const rows = this.db
			.prepare(
				'SELECT token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC'
			)
			.all(userId) as unknown as SessionRow[];
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

	revoke(tokenHash: string): void {
		this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
	}

	revokeUserSessions(userId: number, exceptHash?: string): void {
		if (exceptHash) {
			this.db
				.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
				.run(userId, exceptHash);
		} else {
			this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
		}
	}

	prune(now = Date.now()): number {
		return Number(this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes);
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
