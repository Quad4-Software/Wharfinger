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
	it('lists sessions per user with a current flag', () => {
		const { users, sessions } = stores();
		const u = users.create('alice', 'a-very-long-password', 'operator');
		const other = users.create('bob', 'a-very-long-password', 'viewer');
		const t1 = sessions.create(u.id, 60_000, '10.0.0.1', 'agent-a');
		sessions.create(u.id, 60_000, '10.0.0.2', 'agent-b');
		sessions.create(other.id, 60_000, null, null);

		const mine = sessions.forUser(u.id, hashToken(t1));
		expect(mine).toHaveLength(2);
		expect(mine.filter((s) => s.current)).toHaveLength(1);
		expect(mine.find((s) => s.current)?.tokenHash).toBe(hashToken(t1));
		expect(sessions.forUser(other.id)).toHaveLength(1);
		expect(sessions.forUser(other.id)[0].current).toBe(false);
	});

	it('revokes a single session by full hash', () => {
		const { users, sessions } = stores();
		const u = users.create('alice', 'a-very-long-password', 'operator');
		const t1 = sessions.create(u.id, 60_000, null, null);
		sessions.create(u.id, 60_000, null, null);
		sessions.revoke(hashToken(t1));
		const rest = sessions.forUser(u.id);
		expect(rest).toHaveLength(1);
		expect(rest[0].tokenHash).not.toBe(hashToken(t1));
	});

	it('revokes all user sessions, optionally keeping one', () => {
		const { users, sessions } = stores();
		const u = users.create('alice', 'a-very-long-password', 'operator');
		const keep = sessions.create(u.id, 60_000, null, null);
		sessions.create(u.id, 60_000, null, null);
		sessions.revokeUserSessions(u.id, hashToken(keep));
		expect(sessions.forUser(u.id).map((s) => s.tokenHash)).toEqual([hashToken(keep)]);
		sessions.revokeUserSessions(u.id);
		expect(sessions.forUser(u.id)).toHaveLength(0);
	});

	it('still lists sessions for a disabled user', () => {
		const { users, sessions } = stores();
		const u = users.create('alice', 'a-very-long-password', 'operator');
		sessions.create(u.id, 60_000, null, null);
		users.setDisabled(u.id, true);
		// Incident response needs the list even while sign-in is blocked.
		expect(sessions.forUser(u.id)).toHaveLength(1);
	});

	it('prefix matching resolves to exactly one hash in practice', () => {
		const { users, sessions } = stores();
		const u = users.create('alice', 'a-very-long-password', 'operator');
		for (let i = 0; i < 8; i++) sessions.create(u.id, 60_000, null, null);
		const rows = sessions.forUser(u.id);
		const prefix = rows[0].tokenHash.slice(0, 16);
		const matches = rows.filter((s) => s.tokenHash.startsWith(prefix));
		expect(matches).toHaveLength(1);
		expect(matches[0].tokenHash).toBe(rows[0].tokenHash);
	});
});
