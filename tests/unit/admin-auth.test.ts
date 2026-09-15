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
	it('creates users and returns public fields only', async () => {
		const db = freshDb();
		const users = new UserStore(db);
		const u = await users.create('alice', 'a-very-long-password', 'admin', 'Alice A');
		expect(u.username).toBe('alice');
		expect(u.role).toBe('admin');
		expect(u.displayName).toBe('Alice A');
		expect(u.totpEnabled).toBe(false);
		expect('password_hash' in u).toBe(false);
		expect(await users.count()).toBe(1);
		expect((await users.byId(u.id))?.username).toBe('alice');
	});

	it('enforces case-insensitive unique usernames', async () => {
		const db = freshDb();
		const users = new UserStore(db);
		await users.create('Alice', 'a-very-long-password', 'admin');
		await expect(users.create('ALICE', 'another-long-password', 'operator')).rejects.toThrow();
	});

	it('stores credentials hashed, never plaintext', async () => {
		const db = freshDb();
		const users = new UserStore(db);
		const u = await users.create('bob', 'a-very-long-password', 'operator');
		const row = await users.rowByName('bob');
		expect(row?.password_hash.startsWith('scrypt$')).toBe(true);
		expect(row?.password_hash).not.toContain('a-very-long-password');
		await users.setPassword(u.id, 'a-new-long-password');
		expect((await users.rowByName('bob'))?.password_hash).not.toBe(row?.password_hash);
	});

	it('seals totp secrets at rest and opens them back', async () => {
		const db = freshDb();
		const users = new UserStore(db);
		const u = await users.create('carol', 'a-very-long-password', 'admin');
		await users.setTotp(u.id, 'JBSWY3DPEHPK3PXP', ['h1', 'h2']);
		const row = await users.rowById(u.id);
		expect(row?.totp_secret).not.toBeNull();
		expect(row?.totp_secret).not.toContain('JBSWY3DPEHPK3PXP');
		expect(users.totpSecret(row ?? ({} as never))).toBe('JBSWY3DPEHPK3PXP');
		expect((await users.byId(u.id))?.totpEnabled).toBe(true);
	});

	it('consumes each backup code exactly once', async () => {
		const db = freshDb();
		const users = new UserStore(db);
		const u = await users.create('dave', 'a-very-long-password', 'admin');
		await users.setTotp(u.id, 'JBSWY3DPEHPK3PXP', ['code-hash-1', 'code-hash-2']);
		expect(await users.consumeBackupCode(u.id, 'code-hash-1')).toBe(true);
		expect(await users.consumeBackupCode(u.id, 'code-hash-1')).toBe(false);
		expect(await users.consumeBackupCode(u.id, 'code-hash-2')).toBe(true);
		expect(await users.consumeBackupCode(u.id, 'nope')).toBe(false);
	});
});

describe('SessionStore', () => {
	const TTL = 60_000;

	async function setup(): Promise<{
		db: DatabaseSync;
		users: UserStore;
		sessions: SessionStore;
		userId: number;
	}> {
		const db = freshDb();
		const users = new UserStore(db);
		const sessions = new SessionStore(db, users);
		const userId = (await users.create('eve', 'a-very-long-password', 'admin')).id;
		return { db, users, sessions, userId };
	}

	it('resolves a fresh session to its user', async () => {
		const { sessions, userId } = await setup();
		const token = await sessions.create(userId, TTL, '10.0.0.1', 'agent');
		const r = await sessions.resolve(token, TTL);
		expect(r?.user.id).toBe(userId);
		expect(r?.tokenHash).toBe(hashToken(token));
	});

	it('rejects unknown and expired tokens', async () => {
		const { sessions, userId } = await setup();
		expect(await sessions.resolve('nonexistent', TTL)).toBeNull();
		const token = await sessions.create(userId, -1, null, null);
		expect(await sessions.resolve(token, TTL)).toBeNull();
	});

	it('kills all sessions when the user is disabled', async () => {
		const { users, sessions, userId } = await setup();
		const t1 = await sessions.create(userId, TTL, null, null);
		const t2 = await sessions.create(userId, TTL, null, null);
		await users.setDisabled(userId, true);
		expect(await sessions.resolve(t1, TTL)).toBeNull();
		expect(await sessions.resolve(t2, TTL)).toBeNull();
		expect(await sessions.forUser(userId)).toHaveLength(0);
	});

	it('revokes individual and per-user sessions', async () => {
		const { sessions, userId } = await setup();
		const t1 = await sessions.create(userId, TTL, null, null);
		const t2 = await sessions.create(userId, TTL, null, null);
		await sessions.revoke(hashToken(t1));
		expect(await sessions.resolve(t1, TTL)).toBeNull();
		expect(await sessions.resolve(t2, TTL)).not.toBeNull();
		await sessions.revokeUserSessions(userId, hashToken(t2));
		expect(await sessions.resolve(t2, TTL)).not.toBeNull();
		await sessions.revokeUserSessions(userId);
		expect(await sessions.resolve(t2, TTL)).toBeNull();
	});

	it('renews sessions past half their ttl', async () => {
		const { sessions, userId } = await setup();
		const token = await sessions.create(userId, 1000, null, null);
		const before = (await sessions.forUser(userId))[0].expiresAt;
		// resolve with a much larger ttl: remaining life is < half the new ttl
		await sessions.resolve(token, 1_000_000);
		const after = (await sessions.forUser(userId))[0].expiresAt;
		expect(after).toBeGreaterThan(before);
	});
});

describe('InviteStore', () => {
	it('issues usable invites and reveals the token only once', async () => {
		const db = freshDb();
		const invites = new InviteStore(db);
		const { token, invite } = await invites.create({
			kind: 'invite',
			role: 'operator',
			ttlMs: 60_000
		});
		expect(invites.isUsable(invite)).toBe(true);
		const looked = await invites.lookup(token);
		expect(looked?.role).toBe('operator');
		expect(looked?.tokenHash).toBe(hashToken(token));
		// the stored value is the hash, not the token
		expect(looked?.tokenHash).not.toBe(token);
	});

	it('stops being usable after use, revoke, or expiry', async () => {
		const db = freshDb();
		const invites = new InviteStore(db);

		const used = await invites.create({ kind: 'invite', role: 'admin', ttlMs: 60_000 });
		await invites.markUsed(used.invite.tokenHash);
		expect(invites.isUsable((await invites.lookup(used.token)) ?? used.invite)).toBe(false);

		const revoked = await invites.create({ kind: 'invite', role: 'admin', ttlMs: 60_000 });
		await invites.revoke(revoked.invite.tokenHash);
		expect(invites.isUsable((await invites.lookup(revoked.token)) ?? revoked.invite)).toBe(false);

		const expired = await invites.create({ kind: 'invite', role: 'admin', ttlMs: -1 });
		expect(invites.isUsable(expired.invite)).toBe(false);
	});

	it('revokeForUser invalidates only that users outstanding links', async () => {
		const db = freshDb();
		const users = new UserStore(db);
		const invites = new InviteStore(db);
		const u1 = await users.create('u1', 'a-very-long-password', 'admin');
		const u2 = await users.create('u2', 'a-very-long-password', 'admin');
		const a = await invites.create({ kind: 'reset', role: 'admin', userId: u1.id, ttlMs: 60_000 });
		const b = await invites.create({ kind: 'reset', role: 'admin', userId: u2.id, ttlMs: 60_000 });
		await invites.revokeForUser(u1.id);
		expect(invites.isUsable((await invites.lookup(a.token)) ?? a.invite)).toBe(false);
		expect(invites.isUsable((await invites.lookup(b.token)) ?? b.invite)).toBe(true);
	});

	it('lists only outstanding links in pending()', async () => {
		const db = freshDb();
		const invites = new InviteStore(db);
		const a = await invites.create({ kind: 'invite', role: 'admin', ttlMs: 60_000 });
		await invites.create({ kind: 'invite', role: 'operator', ttlMs: 60_000 });
		await invites.revoke(a.invite.tokenHash);
		expect(await invites.pending()).toHaveLength(1);
		expect(await invites.recent()).toHaveLength(2);
	});
});

describe('LoginProtector', () => {
	const policy = { maxAttempts: 3, lockoutMs: 60_000 };

	it('locks after maxAttempts failures from one key', async () => {
		const db = freshDb();
		const p = new LoginProtector(db);
		await p.record('ip1', 'alice', false);
		await p.record('ip1', 'alice', false);
		expect(await p.lockedUntil('ip1', policy)).toBeNull();
		await p.record('ip1', 'alice', false);
		const until = await p.lockedUntil('ip1', policy);
		expect(until).not.toBeNull();
		expect(until ?? 0).toBeGreaterThan(Date.now());
	});

	it('does not lock other keys', async () => {
		const db = freshDb();
		const p = new LoginProtector(db);
		for (let i = 0; i < 3; i++) await p.record('ip1', 'alice', false);
		expect(await p.lockedUntil('ip2', policy)).toBeNull();
	});

	it('delays but never locks a username under distributed attempts', async () => {
		const db = freshDb();
		const p = new LoginProtector(db);
		await p.record('ip1', 'alice', false);
		await p.record('ip2', 'alice', false);
		await p.record('ip3', 'alice', false);
		// a fourth source against the same account is delayed, not locked,
		// so the legitimate owner is never denied outright
		expect(await p.lockedUntil('ip4', policy)).toBeNull();
		expect(await p.usernameDelayMs('alice', policy)).toBeGreaterThan(0);
		expect(await p.usernameDelayMs('bob', policy)).toBe(0);
		for (let i = 0; i < 20; i++) await p.record(`ipx${i}`, 'alice', false);
		expect(await p.usernameDelayMs('alice', policy)).toBeLessThanOrEqual(5_000);
	});

	it('prunes old attempts', async () => {
		const db = freshDb();
		const p = new LoginProtector(db);
		await p.record('ip1', 'a', false, Date.now() - 8 * 86_400_000);
		await p.record('ip1', 'a', false);
		expect(await p.prune()).toBe(1);
	});
});
