import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '$lib/server/store/db';
import { openSecret } from '$lib/server/admin/crypto';
import { ChatError, ChatStore } from '$lib/server/admin/chat';
import { UserStore } from '$lib/server/admin/users';

process.env.WHARFINGER_SECRET_KEY = 'unit-test-secret-key-material';

function stores(): { db: DatabaseSync; users: UserStore; chat: ChatStore } {
	const db = openDb(mkdtempSync(join(tmpdir(), 'wharfinger-chat-')));
	const users = new UserStore(db);
	return { db, users, chat: new ChatStore(db, users) };
}

function expectChatError(fn: () => unknown, status: number): void {
	try {
		fn();
	} catch (err) {
		expect(err).toBeInstanceOf(ChatError);
		expect((err as ChatError).status).toBe(status);
		return;
	}
	expect.unreachable('expected ChatError');
}

describe('ChatStore dms', () => {
	it('canonicalizes the pair key and reuses the room', () => {
		const { users, chat } = stores();
		const a = users.create('alice', 'a-very-long-password', 'operator');
		const b = users.create('bob', 'a-very-long-password', 'viewer');

		const ab = chat.openDm(a.id, b.id);
		const ba = chat.openDm(b.id, a.id);
		expect(ab.id).toBe(ba.id);
		expect(ab.kind).toBe('dm');
		expect(ab.members.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());

		// Repeat opens are idempotent (the concurrent-create path).
		expect(chat.openDm(a.id, b.id).id).toBe(ab.id);
	});

	it('rejects self dms and unknown users', () => {
		const { users, chat } = stores();
		const a = users.create('alice', 'a-very-long-password', 'operator');
		expectChatError(() => chat.openDm(a.id, a.id), 422);
		expectChatError(() => chat.openDm(a.id, 99999), 422);
	});
});

describe('ChatStore messages', () => {
	it('enforces membership on send and read', () => {
		const { users, chat } = stores();
		const a = users.create('alice', 'a-very-long-password', 'operator');
		const b = users.create('bob', 'a-very-long-password', 'viewer');
		const c = users.create('carol', 'a-very-long-password', 'viewer');
		const room = chat.openDm(a.id, b.id);

		expectChatError(() => chat.send(room.id, c.id, 'hi'), 403);
		expectChatError(() => chat.list(room.id, c.id), 403);
		expectChatError(() => {
			chat.markRead(room.id, c.id, 1);
		}, 403);
		expect(chat.send(room.id, a.id, 'hi').body).toBe('hi');
	});

	it('strips control chars, trims, caps length, rejects empty', () => {
		const { users, chat } = stores();
		const a = users.create('alice', 'a-very-long-password', 'operator');
		const b = users.create('bob', 'a-very-long-password', 'viewer');
		const room = chat.openDm(a.id, b.id);

		expectChatError(() => chat.send(room.id, a.id, '   \n\n  '), 422);
		expectChatError(() => chat.send(room.id, a.id, '\x07\x08'), 422);

		const stripped = chat.send(room.id, a.id, 'a\x07b\tc\nd');
		expect(stripped.body).toBe('abc\nd');

		const long = chat.send(room.id, a.id, 'x'.repeat(5000));
		expect(long.body).toHaveLength(4000);
	});

	it('seals bodies at rest and unseals on read', () => {
		const { db, users, chat } = stores();
		const a = users.create('alice', 'a-very-long-password', 'operator');
		const b = users.create('bob', 'a-very-long-password', 'viewer');
		const room = chat.openDm(a.id, b.id);
		const sent = chat.send(room.id, a.id, 'sensitive ops detail');

		const raw = db.prepare('SELECT body FROM chat_messages WHERE id = ?').get(sent.id) as {
			body: string;
		};
		expect(raw.body.startsWith('v1.')).toBe(true);
		expect(raw.body).not.toContain('sensitive');
		expect(openSecret(raw.body)).toBe('sensitive ops detail');

		const page = chat.list(room.id, b.id);
		expect(page.messages[0].body).toBe('sensitive ops detail');
	});

	it('counts unread and advances the read cursor', () => {
		const { users, chat } = stores();
		const a = users.create('alice', 'a-very-long-password', 'operator');
		const b = users.create('bob', 'a-very-long-password', 'viewer');
		const room = chat.openDm(a.id, b.id);
		const m1 = chat.send(room.id, a.id, 'one');
		const m2 = chat.send(room.id, a.id, 'two');

		const view = chat.listRoomsFor(b.id).find((r) => r.id === room.id);
		expect(view?.unread).toBe(2);
		expect(view?.preview?.body).toBe('two');

		chat.markRead(room.id, b.id, m1.id);
		expect(chat.listRoomsFor(b.id)[0].unread).toBe(1);
		chat.markRead(room.id, b.id, m2.id);
		expect(chat.listRoomsFor(b.id)[0].unread).toBe(0);
		// The cursor never rewinds.
		chat.markRead(room.id, b.id, m1.id);
		expect(chat.listRoomsFor(b.id)[0].unread).toBe(0);
	});

	it('edits inside the window, rejects strangers and stale edits', () => {
		const { db, users, chat } = stores();
		const a = users.create('alice', 'a-very-long-password', 'operator');
		const b = users.create('bob', 'a-very-long-password', 'viewer');
		const room = chat.openDm(a.id, b.id);
		const m = chat.send(room.id, a.id, 'typo');

		expectChatError(() => chat.edit(m.id, b.id, 'fixed'), 403);
		const edited = chat.edit(m.id, a.id, 'fixed');
		expect(edited.body).toBe('fixed');
		expect(edited.editedAt).not.toBeNull();

		// Age the row past the 10 minute window.
		db.prepare('UPDATE chat_messages SET at = ? WHERE id = ?').run(Date.now() - 11 * 60_000, m.id);
		expectChatError(() => chat.edit(m.id, a.id, 'late'), 403);
	});

	it('soft deletes for the author or a moderator, tombstones reads', () => {
		const { users, chat } = stores();
		const a = users.create('alice', 'a-very-long-password', 'operator');
		const b = users.create('bob', 'a-very-long-password', 'viewer');
		const room = chat.openDm(a.id, b.id);
		const m1 = chat.send(room.id, a.id, 'one');
		const m2 = chat.send(room.id, a.id, 'two');

		expectChatError(() => chat.remove(m1.id, b.id, false), 403);
		const gone = chat.remove(m1.id, a.id, false);
		expect(gone.deletedAt).not.toBeNull();
		expect(gone.body).toBe('');

		// Moderator path (users.manage holder) deletes others' messages.
		const mod = chat.remove(m2.id, b.id, true);
		expect(mod.deletedAt).not.toBeNull();

		const page = chat.list(room.id, b.id);
		expect(page.messages.every((m) => m.deletedAt !== null && m.body === '')).toBe(true);
	});

	it('paginates backwards with stable ordering', () => {
		const { users, chat } = stores();
		const a = users.create('alice', 'a-very-long-password', 'operator');
		const b = users.create('bob', 'a-very-long-password', 'viewer');
		const room = chat.openDm(a.id, b.id);
		for (let i = 1; i <= 60; i++) chat.send(room.id, a.id, `m${i}`);

		const first = chat.list(room.id, b.id);
		expect(first.messages).toHaveLength(50);
		expect(first.hasMore).toBe(true);
		expect(first.messages[49].body).toBe('m60');
		expect(first.messages[0].body).toBe('m11');

		const second = chat.list(room.id, b.id, first.messages[0].id);
		expect(second.messages).toHaveLength(10);
		expect(second.hasMore).toBe(false);
		expect(second.messages.map((m) => m.body)).toEqual(
			Array.from({ length: 10 }, (_, i) => `m${i + 1}`)
		);
		// Ids ascend within a page.
		const ids = first.messages.map((m) => m.id);
		expect(ids).toEqual([...ids].sort((x, y) => x - y));
	});
});

describe('ChatStore rooms', () => {
	it('validates name and members, lists with previews', () => {
		const { users, chat } = stores();
		const a = users.create('alice', 'a-very-long-password', 'operator');
		const b = users.create('bob', 'a-very-long-password', 'viewer');
		const c = users.create('carol', 'a-very-long-password', 'viewer');

		expectChatError(() => chat.createRoom('  ', [b.id], a.id), 422);
		expectChatError(() => chat.createRoom('r', [99999], a.id), 422);
		expectChatError(() => chat.createRoom('r', [], a.id), 422);

		const room = chat.createRoom('ops', [b.id, c.id], a.id);
		expect(room.members).toHaveLength(3);
		chat.send(room.id, b.id, 'hello room');
		const view = chat.listRoomsFor(a.id)[0];
		expect(view.preview?.body).toBe('hello room');
		expect(view.unread).toBe(1);
	});

	it('manages membership with creator and admin rules', () => {
		const { users, chat } = stores();
		const a = users.create('alice', 'a-very-long-password', 'operator');
		const b = users.create('bob', 'a-very-long-password', 'viewer');
		const c = users.create('carol', 'a-very-long-password', 'viewer');
		const d = users.create('dave', 'a-very-long-password', 'viewer');
		const room = chat.createRoom('ops', [b.id], a.id);

		// Any member may add.
		chat.addMember(room.id, b.id, c.id);
		expect(chat.memberIds(room.id).sort()).toEqual([a.id, b.id, c.id].sort());

		// Non-creator non-admin cannot remove others, but can leave.
		expectChatError(() => {
			chat.removeMember(room.id, b.id, c.id, false);
		}, 403);
		chat.removeMember(room.id, c.id, c.id, false);
		expect(chat.memberIds(room.id).sort()).toEqual([a.id, b.id].sort());

		// Creator and admin removals.
		chat.addMember(room.id, a.id, c.id);
		chat.removeMember(room.id, a.id, c.id, false);
		chat.addMember(room.id, a.id, d.id);
		chat.removeMember(room.id, b.id, d.id, true);
		expect(chat.memberIds(room.id).sort()).toEqual([a.id, b.id].sort());

		// Dm membership is fixed.
		const dm = chat.openDm(a.id, b.id);
		expectChatError(() => {
			chat.addMember(dm.id, a.id, c.id);
		}, 422);
		expectChatError(() => {
			chat.removeMember(dm.id, a.id, b.id, true);
		}, 422);
	});
});
