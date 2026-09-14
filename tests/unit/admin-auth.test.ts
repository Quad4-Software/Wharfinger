import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '$lib/server/store/db';
import { UserStore } from '$lib/server/admin/users';
import { SessionStore } from '$lib/server/admin/sessions';
import { InviteStore } from '$lib/server/admin/invites';
import { LoginProtector } from '$lib/server/admin/protection';
import { hashToken } from '$lib/server/admin/crypto';

process.env.WHARFINGER_SECRET_KEY = 'unit-test-secret-key-material';

function freshDb(): DatabaseSync {
	return openDb(mkdtempSync(join(tmpdir(), 'wharfinger-testdb-')));
}

describe('UserStore', () => {
	it('creates users and returns public fields only', () => {
		const db = freshDb();
		const users = new UserStore(db);
		const u = users.create('alice', 'a-very-long-password', 'admin', 'Alice A');
		expect(u.username).toBe('alice');
		expect(u.role).toBe('admin');
		expect(u.displayName).toBe('Alice A');
		expect(u.totpEnabled).toBe(false);
		expect('password_hash' in u).toBe(false);
		expect(users.count()).toBe(1);
		expect(users.byId(u.id)?.username).toBe('alice');
	});

	it('enforces case-insensitive unique usernames', () => {
		const db = freshDb();
		const users = new UserStore(db);
		users.create('Alice', 'a-very-long-password', 'admin');
		expect(() => users.create('ALICE', 'another-long-password', 'operator')).toThrow();
	});

	it('stores credentials hashed, never plaintext', () => {
		const db = freshDb();
		const users = new UserStore(db);
		const u = users.create('bob', 'a-very-long-password', 'operator');
		const row = users.rowByName('bob');
		expect(row?.password_hash.startsWith('scrypt$')).toBe(true);
		expect(row?.password_hash).not.toContain('a-very-long-password');
		users.setPassword(u.id, 'a-new-long-password');
		expect(users.rowByName('bob')?.password_hash).not.toBe(row?.password_hash);
	});

	it('seals totp secrets at rest and opens them back', () => {
		const db = freshDb();
		const users = new UserStore(db);
		const u = users.create('carol', 'a-very-long-password', 'admin');
		users.setTotp(u.id, 'JBSWY3DPEHPK3PXP', ['h1', 'h2']);
		const row = users.rowById(u.id);
		expect(row?.totp_secret).not.toBeNull();
		expect(row?.totp_secret).not.toContain('JBSWY3DPEHPK3PXP');
		expect(users.totpSecret(row ?? ({} as never))).toBe('JBSWY3DPEHPK3PXP');
		expect(users.byId(u.id)?.totpEnabled).toBe(true);
	});

	it('consumes each backup code exactly once', () => {
		const db = freshDb();
		const users = new UserStore(db);
		const u = users.create('dave', 'a-very-long-password', 'admin');
		users.setTotp(u.id, 'JBSWY3DPEHPK3PXP', ['code-hash-1', 'code-hash-2']);
		expect(users.consumeBackupCode(u.id, 'code-hash-1')).toBe(true);
		expect(users.consumeBackupCode(u.id, 'code-hash-1')).toBe(false);
		expect(users.consumeBackupCode(u.id, 'code-hash-2')).toBe(true);
		expect(users.consumeBackupCode(u.id, 'nope')).toBe(false);
	});
});

describe('SessionStore', () => {
	const TTL = 60_000;

	function setup(): { db: DatabaseSync; users: UserStore; sessions: SessionStore; userId: number } {
		const db = freshDb();
		const users = new UserStore(db);
		const sessions = new SessionStore(db, users);
		const userId = users.create('eve', 'a-very-long-password', 'admin').id;
		return { db, users, sessions, userId };
	}

	it('resolves a fresh session to its user', () => {
		const { sessions, userId } = setup();
		const token = sessions.create(userId, TTL, '10.0.0.1', 'agent');
		const r = sessions.resolve(token, TTL);
		expect(r?.user.id).toBe(userId);
		expect(r?.tokenHash).toBe(hashToken(token));
	});

	it('rejects unknown and expired tokens', () => {
		const { sessions, userId } = setup();
		expect(sessions.resolve('nonexistent', TTL)).toBeNull();
		const token = sessions.create(userId, -1, null, null);
		expect(sessions.resolve(token, TTL)).toBeNull();
	});

	it('kills all sessions when the user is disabled', () => {
		const { users, sessions, userId } = setup();
		const t1 = sessions.create(userId, TTL, null, null);
		const t2 = sessions.create(userId, TTL, null, null);
		users.setDisabled(userId, true);
		expect(sessions.resolve(t1, TTL)).toBeNull();
		expect(sessions.resolve(t2, TTL)).toBeNull();
		expect(sessions.forUser(userId)).toHaveLength(0);
	});

	it('revokes individual and per-user sessions', () => {
		const { sessions, userId } = setup();
		const t1 = sessions.create(userId, TTL, null, null);
		const t2 = sessions.create(userId, TTL, null, null);
		sessions.revoke(hashToken(t1));
		expect(sessions.resolve(t1, TTL)).toBeNull();
		expect(sessions.resolve(t2, TTL)).not.toBeNull();
		sessions.revokeUserSessions(userId, hashToken(t2));
		expect(sessions.resolve(t2, TTL)).not.toBeNull();
		sessions.revokeUserSessions(userId);
		expect(sessions.resolve(t2, TTL)).toBeNull();
	});

	it('renews sessions past half their ttl', () => {
		const { sessions, userId } = setup();
		const token = sessions.create(userId, 1000, null, null);
		const before = sessions.forUser(userId)[0].expiresAt;
		// resolve with a much larger ttl: remaining life is < half the new ttl
		sessions.resolve(token, 1_000_000);
		const after = sessions.forUser(userId)[0].expiresAt;
		expect(after).toBeGreaterThan(before);
	});
});

describe('InviteStore', () => {
	it('issues usable invites and reveals the token only once', () => {
		const db = freshDb();
		const invites = new InviteStore(db);
		const { token, invite } = invites.create({
			kind: 'invite',
			role: 'operator',
			ttlMs: 60_000
		});
		expect(invites.isUsable(invite)).toBe(true);
		const looked = invites.lookup(token);
		expect(looked?.role).toBe('operator');
		expect(looked?.tokenHash).toBe(hashToken(token));
		// the stored value is the hash, not the token
		expect(looked?.tokenHash).not.toBe(token);
	});

	it('stops being usable after use, revoke, or expiry', () => {
		const db = freshDb();
		const invites = new InviteStore(db);

		const used = invites.create({ kind: 'invite', role: 'admin', ttlMs: 60_000 });
		invites.markUsed(used.invite.tokenHash);
		expect(invites.isUsable(invites.lookup(used.token) ?? used.invite)).toBe(false);

		const revoked = invites.create({ kind: 'invite', role: 'admin', ttlMs: 60_000 });
		invites.revoke(revoked.invite.tokenHash);
		expect(invites.isUsable(invites.lookup(revoked.token) ?? revoked.invite)).toBe(false);

		const expired = invites.create({ kind: 'invite', role: 'admin', ttlMs: -1 });
		expect(invites.isUsable(expired.invite)).toBe(false);
	});

	it('revokeForUser invalidates only that users outstanding links', () => {
		const db = freshDb();
		const users = new UserStore(db);
		const invites = new InviteStore(db);
		const u1 = users.create('u1', 'a-very-long-password', 'admin');
		const u2 = users.create('u2', 'a-very-long-password', 'admin');
		const a = invites.create({ kind: 'reset', role: 'admin', userId: u1.id, ttlMs: 60_000 });
		const b = invites.create({ kind: 'reset', role: 'admin', userId: u2.id, ttlMs: 60_000 });
		invites.revokeForUser(u1.id);
		expect(invites.isUsable(invites.lookup(a.token) ?? a.invite)).toBe(false);
		expect(invites.isUsable(invites.lookup(b.token) ?? b.invite)).toBe(true);
	});

	it('lists only outstanding links in pending()', () => {
		const db = freshDb();
		const invites = new InviteStore(db);
		const a = invites.create({ kind: 'invite', role: 'admin', ttlMs: 60_000 });
		invites.create({ kind: 'invite', role: 'operator', ttlMs: 60_000 });
		invites.revoke(a.invite.tokenHash);
		expect(invites.pending()).toHaveLength(1);
		expect(invites.recent()).toHaveLength(2);
	});
});

describe('LoginProtector', () => {
	const policy = { maxAttempts: 3, lockoutMs: 60_000 };

	it('locks after maxAttempts failures from one key', () => {
		const db = freshDb();
		const p = new LoginProtector(db);
		p.record('ip1', 'alice', false);
		p.record('ip1', 'alice', false);
		expect(p.lockedUntil('ip1', policy)).toBeNull();
		p.record('ip1', 'alice', false);
		const until = p.lockedUntil('ip1', policy);
		expect(until).not.toBeNull();
		expect(until ?? 0).toBeGreaterThan(Date.now());
	});

	it('does not lock other keys', () => {
		const db = freshDb();
		const p = new LoginProtector(db);
		for (let i = 0; i < 3; i++) p.record('ip1', 'alice', false);
		expect(p.lockedUntil('ip2', policy)).toBeNull();
	});

	it('delays but never locks a username under distributed attempts', () => {
		const db = freshDb();
		const p = new LoginProtector(db);
		p.record('ip1', 'alice', false);
		p.record('ip2', 'alice', false);
		p.record('ip3', 'alice', false);
		// a fourth source against the same account is delayed, not locked,
		// so the legitimate owner is never denied outright
		expect(p.lockedUntil('ip4', policy)).toBeNull();
		expect(p.usernameDelayMs('alice', policy)).toBeGreaterThan(0);
		expect(p.usernameDelayMs('bob', policy)).toBe(0);
		for (let i = 0; i < 20; i++) p.record(`ipx${i}`, 'alice', false);
		expect(p.usernameDelayMs('alice', policy)).toBeLessThanOrEqual(5_000);
	});

	it('prunes old attempts', () => {
		const db = freshDb();
		const p = new LoginProtector(db);
		p.record('ip1', 'a', false, Date.now() - 8 * 86_400_000);
		p.record('ip1', 'a', false);
		expect(p.prune()).toBe(1);
	});
});
