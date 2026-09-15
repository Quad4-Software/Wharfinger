import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '$lib/server/store/db';
import { hashToken } from '$lib/server/admin/crypto';
import { SessionStore } from '$lib/server/admin/sessions';
import { UserStore } from '$lib/server/admin/users';

process.env.WHARFINGER_SECRET_KEY = 'unit-test-secret-key-material';

function stores(): { db: DatabaseSync; users: UserStore; sessions: SessionStore } {
	const db = openDb(mkdtempSync(join(tmpdir(), 'wharfinger-sessions-')));
	const users = new UserStore(db);
	return { db, users, sessions: new SessionStore(db, users) };
}

describe('SessionStore', () => {
	it('lists sessions per user with a current flag', async () => {
		const { users, sessions } = stores();
		const u = await users.create('alice', 'a-very-long-password', 'operator');
		const other = await users.create('bob', 'a-very-long-password', 'viewer');
		const t1 = await sessions.create(u.id, 60_000, '10.0.0.1', 'agent-a');
		await sessions.create(u.id, 60_000, '10.0.0.2', 'agent-b');
		await sessions.create(other.id, 60_000, null, null);

		const mine = await sessions.forUser(u.id, hashToken(t1));
		expect(mine).toHaveLength(2);
		expect(mine.filter((s) => s.current)).toHaveLength(1);
		expect(mine.find((s) => s.current)?.tokenHash).toBe(hashToken(t1));
		expect(await sessions.forUser(other.id)).toHaveLength(1);
		expect((await sessions.forUser(other.id))[0].current).toBe(false);
	});

	it('revokes a single session by full hash', async () => {
		const { users, sessions } = stores();
		const u = await users.create('alice', 'a-very-long-password', 'operator');
		const t1 = await sessions.create(u.id, 60_000, null, null);
		await sessions.create(u.id, 60_000, null, null);
		await sessions.revoke(hashToken(t1));
		const rest = await sessions.forUser(u.id);
		expect(rest).toHaveLength(1);
		expect(rest[0].tokenHash).not.toBe(hashToken(t1));
	});

	it('revokes all user sessions, optionally keeping one', async () => {
		const { users, sessions } = stores();
		const u = await users.create('alice', 'a-very-long-password', 'operator');
		const keep = await sessions.create(u.id, 60_000, null, null);
		await sessions.create(u.id, 60_000, null, null);
		await sessions.revokeUserSessions(u.id, hashToken(keep));
		expect((await sessions.forUser(u.id)).map((s) => s.tokenHash)).toEqual([hashToken(keep)]);
		await sessions.revokeUserSessions(u.id);
		expect(await sessions.forUser(u.id)).toHaveLength(0);
	});

	it('still lists sessions for a disabled user', async () => {
		const { users, sessions } = stores();
		const u = await users.create('alice', 'a-very-long-password', 'operator');
		await sessions.create(u.id, 60_000, null, null);
		await users.setDisabled(u.id, true);
		// Incident response needs the list even while sign-in is blocked.
		expect(await sessions.forUser(u.id)).toHaveLength(1);
	});

	it('prefix matching resolves to exactly one hash in practice', async () => {
		const { users, sessions } = stores();
		const u = await users.create('alice', 'a-very-long-password', 'operator');
		for (let i = 0; i < 8; i++) await sessions.create(u.id, 60_000, null, null);
		const rows = await sessions.forUser(u.id);
		const prefix = rows[0].tokenHash.slice(0, 16);
		const matches = rows.filter((s) => s.tokenHash.startsWith(prefix));
		expect(matches).toHaveLength(1);
		expect(matches[0].tokenHash).toBe(rows[0].tokenHash);
	});
});
