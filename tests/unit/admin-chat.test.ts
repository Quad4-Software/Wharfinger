import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '$lib/server/store/db';
import { openSecret } from '$lib/server/admin/crypto';
import { ChatError, ChatStore } from '$lib/server/admin/chat';
import { attachmentKey, attachmentPath, cleanFilename } from '$lib/server/admin/chat-files';
import { UserStore } from '$lib/server/admin/users';

process.env.WHARFINGER_SECRET_KEY = 'unit-test-secret-key-material';

function stores(): { dir: string; db: DatabaseSync; users: UserStore; chat: ChatStore } {
	const dir = mkdtempSync(join(tmpdir(), 'wharfinger-chat-'));
	const db = openDb(dir);
	const users = new UserStore(db);
	return { dir, db, users, chat: new ChatStore(db, users, dir) };
}

async function expectChatError(fn: () => unknown, status: number): Promise<void> {
	try {
		await fn();
	} catch (err) {
		expect(err).toBeInstanceOf(ChatError);
		expect((err as ChatError).status).toBe(status);
		return;
	}
	expect.unreachable('expected ChatError');
}

describe('ChatStore dms', () => {
	it('canonicalizes the pair key and reuses the room', async () => {
		const { users, chat } = stores();
		const a = await users.create('alice', 'a-very-long-password', 'operator');
		const b = await users.create('bob', 'a-very-long-password', 'viewer');

		const ab = await chat.openDm(a.id, b.id);
		const ba = await chat.openDm(b.id, a.id);
		expect(ab.id).toBe(ba.id);
		expect(ab.kind).toBe('dm');
		expect(ab.members.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());

		// Repeat opens are idempotent (the concurrent-create path).
		expect((await chat.openDm(a.id, b.id)).id).toBe(ab.id);
	});

	it('rejects self dms and unknown users', async () => {
		const { users, chat } = stores();
		const a = await users.create('alice', 'a-very-long-password', 'operator');
		await expectChatError(() => chat.openDm(a.id, a.id), 422);
		await expectChatError(() => chat.openDm(a.id, 99999), 422);
	});
});

describe('ChatStore messages', () => {
	it('enforces membership on send and read', async () => {
		const { users, chat } = stores();
		const a = await users.create('alice', 'a-very-long-password', 'operator');
		const b = await users.create('bob', 'a-very-long-password', 'viewer');
		const c = await users.create('carol', 'a-very-long-password', 'viewer');
		const room = await chat.openDm(a.id, b.id);

		await expectChatError(() => chat.send(room.id, c.id, 'hi'), 403);
		await expectChatError(() => chat.list(room.id, c.id), 403);
		await expectChatError(() => chat.markRead(room.id, c.id, 1), 403);
		expect((await chat.send(room.id, a.id, 'hi')).body).toBe('hi');
	});

	it('strips control chars, trims, caps length, rejects empty', async () => {
		const { users, chat } = stores();
		const a = await users.create('alice', 'a-very-long-password', 'operator');
		const b = await users.create('bob', 'a-very-long-password', 'viewer');
		const room = await chat.openDm(a.id, b.id);

		await expectChatError(() => chat.send(room.id, a.id, '   \n\n  '), 422);
		await expectChatError(() => chat.send(room.id, a.id, '\x07\x08'), 422);

		const stripped = await chat.send(room.id, a.id, 'a\x07b\tc\nd');
		expect(stripped.body).toBe('abc\nd');

		const long = await chat.send(room.id, a.id, 'x'.repeat(5000));
		expect(long.body).toHaveLength(4000);
	});

	it('seals bodies at rest and unseals on read', async () => {
		const { db, users, chat } = stores();
		const a = await users.create('alice', 'a-very-long-password', 'operator');
		const b = await users.create('bob', 'a-very-long-password', 'viewer');
		const room = await chat.openDm(a.id, b.id);
		const sent = await chat.send(room.id, a.id, 'sensitive ops detail');

		const raw = db.prepare('SELECT body FROM chat_messages WHERE id = ?').get(sent.id) as {
			body: string;
		};
		expect(raw.body.startsWith('v1.')).toBe(true);
		expect(raw.body).not.toContain('sensitive');
		expect(openSecret(raw.body)).toBe('sensitive ops detail');

		const page = await chat.list(room.id, b.id);
		expect(page.messages[0].body).toBe('sensitive ops detail');
	});

	it('counts unread and advances the read cursor', async () => {
		const { users, chat } = stores();
		const a = await users.create('alice', 'a-very-long-password', 'operator');
		const b = await users.create('bob', 'a-very-long-password', 'viewer');
		const room = await chat.openDm(a.id, b.id);
		const m1 = await chat.send(room.id, a.id, 'one');
		const m2 = await chat.send(room.id, a.id, 'two');

		const view = (await chat.listRoomsFor(b.id)).find((r) => r.id === room.id);
		expect(view?.unread).toBe(2);
		expect(view?.preview?.body).toBe('two');

		await chat.markRead(room.id, b.id, m1.id);
		expect((await chat.listRoomsFor(b.id))[0].unread).toBe(1);
		await chat.markRead(room.id, b.id, m2.id);
		expect((await chat.listRoomsFor(b.id))[0].unread).toBe(0);
		// The cursor never rewinds.
		await chat.markRead(room.id, b.id, m1.id);
		expect((await chat.listRoomsFor(b.id))[0].unread).toBe(0);
	});

	it('edits inside the window, rejects strangers and stale edits', async () => {
		const { db, users, chat } = stores();
		const a = await users.create('alice', 'a-very-long-password', 'operator');
		const b = await users.create('bob', 'a-very-long-password', 'viewer');
		const room = await chat.openDm(a.id, b.id);
		const m = await chat.send(room.id, a.id, 'typo');

		await expectChatError(() => chat.edit(m.id, b.id, 'fixed'), 403);
		const edited = await chat.edit(m.id, a.id, 'fixed');
		expect(edited.body).toBe('fixed');
		expect(edited.editedAt).not.toBeNull();

		// Age the row past the 10 minute window.
		db.prepare('UPDATE chat_messages SET at = ? WHERE id = ?').run(Date.now() - 11 * 60_000, m.id);
		await expectChatError(() => chat.edit(m.id, a.id, 'late'), 403);
	});

	it('soft deletes for the author or a moderator, tombstones reads', async () => {
		const { users, chat } = stores();
		const a = await users.create('alice', 'a-very-long-password', 'operator');
		const b = await users.create('bob', 'a-very-long-password', 'viewer');
		const room = await chat.openDm(a.id, b.id);
		const m1 = await chat.send(room.id, a.id, 'one');
		const m2 = await chat.send(room.id, a.id, 'two');

		await expectChatError(() => chat.remove(m1.id, b.id, false), 403);
		const gone = await chat.remove(m1.id, a.id, false);
		expect(gone.deletedAt).not.toBeNull();
		expect(gone.body).toBe('');

		// Moderator path (users.manage holder) deletes others' messages.
		const mod = await chat.remove(m2.id, b.id, true);
		expect(mod.deletedAt).not.toBeNull();

		const page = await chat.list(room.id, b.id);
		expect(page.messages.every((m) => m.deletedAt !== null && m.body === '')).toBe(true);
	});

	it('paginates backwards with stable ordering', async () => {
		const { users, chat } = stores();
		const a = await users.create('alice', 'a-very-long-password', 'operator');
		const b = await users.create('bob', 'a-very-long-password', 'viewer');
		const room = await chat.openDm(a.id, b.id);
		for (let i = 1; i <= 60; i++) await chat.send(room.id, a.id, `m${i}`);

		const first = await chat.list(room.id, b.id);
		expect(first.messages).toHaveLength(50);
		expect(first.hasMore).toBe(true);
		expect(first.messages[49].body).toBe('m60');
		expect(first.messages[0].body).toBe('m11');

		const second = await chat.list(room.id, b.id, first.messages[0].id);
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
	it('validates name and members, lists with previews', async () => {
		const { users, chat } = stores();
		const a = await users.create('alice', 'a-very-long-password', 'operator');
		const b = await users.create('bob', 'a-very-long-password', 'viewer');
		const c = await users.create('carol', 'a-very-long-password', 'viewer');

		await expectChatError(() => chat.createRoom('  ', [b.id], a.id), 422);
		await expectChatError(() => chat.createRoom('r', [99999], a.id), 422);

		// A room with only the creator is allowed; members can be added later.
		const solo = await chat.createRoom('notes', [], a.id);
		expect(solo.members).toHaveLength(1);

		const room = await chat.createRoom('ops', [b.id, c.id], a.id);
		expect(room.members).toHaveLength(3);
		await chat.send(room.id, b.id, 'hello room');
		const view = (await chat.listRoomsFor(a.id))[0];
		expect(view.preview?.body).toBe('hello room');
		expect(view.unread).toBe(1);
	});

	it('manages membership with creator and admin rules', async () => {
		const { users, chat } = stores();
		const a = await users.create('alice', 'a-very-long-password', 'operator');
		const b = await users.create('bob', 'a-very-long-password', 'viewer');
		const c = await users.create('carol', 'a-very-long-password', 'viewer');
		const d = await users.create('dave', 'a-very-long-password', 'viewer');
		const room = await chat.createRoom('ops', [b.id], a.id);

		// Any member may add.
		await chat.addMember(room.id, b.id, c.id);
		expect((await chat.memberIds(room.id)).sort()).toEqual([a.id, b.id, c.id].sort());

		// Non-creator non-admin cannot remove others, but can leave.
		await expectChatError(() => chat.removeMember(room.id, b.id, c.id, false), 403);
		await chat.removeMember(room.id, c.id, c.id, false);
		expect((await chat.memberIds(room.id)).sort()).toEqual([a.id, b.id].sort());

		// Creator and admin removals.
		await chat.addMember(room.id, a.id, c.id);
		await chat.removeMember(room.id, a.id, c.id, false);
		await chat.addMember(room.id, a.id, d.id);
		await chat.removeMember(room.id, b.id, d.id, true);
		expect((await chat.memberIds(room.id)).sort()).toEqual([a.id, b.id].sort());

		// Dm membership is fixed.
		const dm = await chat.openDm(a.id, b.id);
		await expectChatError(() => chat.addMember(dm.id, a.id, c.id), 422);
		await expectChatError(() => chat.removeMember(dm.id, a.id, b.id, true), 422);
	});
});

describe('ChatStore attachments', () => {
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

	it('rejects bad mime, oversize, empty, and non-member uploads', async () => {
		const { users, chat } = stores();
		const a = await users.create('alice', 'a-very-long-password', 'operator');
		const b = await users.create('bob', 'a-very-long-password', 'viewer');
		const c = await users.create('carol', 'a-very-long-password', 'viewer');
		const room = await chat.openDm(a.id, b.id);

		await expectChatError(
			() =>
				chat.uploadAttachment(room.id, a.id, {
					name: 'evil.html',
					mime: 'text/html',
					data: png
				}),
			422
		);
		await expectChatError(
			() =>
				chat.uploadAttachment(room.id, a.id, {
					name: 'big.png',
					mime: 'image/png',
					data: new Uint8Array(10 * 1024 * 1024 + 1)
				}),
			413
		);
		await expectChatError(
			() =>
				chat.uploadAttachment(room.id, a.id, {
					name: 'empty.png',
					mime: 'image/png',
					data: new Uint8Array(0)
				}),
			422
		);
		await expectChatError(
			() =>
				chat.uploadAttachment(room.id, c.id, {
					name: 'a.png',
					mime: 'image/png',
					data: png
				}),
			403
		);
		await expectChatError(
			() =>
				chat.uploadAttachment('no-such-room', a.id, {
					name: 'a.png',
					mime: 'image/png',
					data: png
				}),
			404
		);
	});

	it('sanitizes the filename and stores the file under the room dir', async () => {
		const { dir, users, chat } = stores();
		const a = await users.create('alice', 'a-very-long-password', 'operator');
		const b = await users.create('bob', 'a-very-long-password', 'viewer');
		const room = await chat.openDm(a.id, b.id);

		const att = await chat.uploadAttachment(room.id, a.id, {
			name: '../../etc/passwd\x07.png',
			mime: 'image/png',
			data: png
		});
		expect(att.name).toBe('passwd.png');
		expect(att.size).toBe(png.length);
		// The disk key is id-based under the room directory.
		const files = readdirSync(join(dir, 'chat-attachments', room.id));
		expect(files).toHaveLength(1);
		expect(files[0].startsWith(att.id)).toBe(true);
		expect(files[0].endsWith('.png')).toBe(true);
	});

	it('attaches uploads to a send and serializes them on the message', async () => {
		const { users, chat } = stores();
		const a = await users.create('alice', 'a-very-long-password', 'operator');
		const b = await users.create('bob', 'a-very-long-password', 'viewer');
		const room = await chat.openDm(a.id, b.id);

		const att = await chat.uploadAttachment(room.id, a.id, {
			name: 'shot.png',
			mime: 'image/png',
			data: png
		});
		// Attachment-only sends are allowed.
		const m = await chat.send(room.id, a.id, '', [att.id]);
		expect(m.body).toBe('');
		expect(m.attachments).toEqual([
			{ id: att.id, name: 'shot.png', mime: 'image/png', size: png.length }
		]);

		// History and the room preview carry the attachment.
		const page = await chat.list(room.id, b.id);
		expect(page.messages.at(-1)?.attachments).toHaveLength(1);
		expect(page.messages.at(-1)?.attachments[0].name).toBe('shot.png');
		const view = (await chat.listRoomsFor(b.id)).find((r) => r.id === room.id);
		expect(view?.preview?.body).toBe('shot.png');

		// A second send cannot reuse the claimed id.
		await expectChatError(() => chat.send(room.id, a.id, 'again', [att.id]), 422);
	});

	it('rejects attachments from other rooms, other uploaders, and bad ids', async () => {
		const { users, chat } = stores();
		const a = await users.create('alice', 'a-very-long-password', 'operator');
		const b = await users.create('bob', 'a-very-long-password', 'viewer');
		const room = await chat.openDm(a.id, b.id);
		const other = await chat.createRoom('side', [b.id], b.id);

		const foreign = await chat.uploadAttachment(other.id, b.id, {
			name: 'x.png',
			mime: 'image/png',
			data: png
		});
		const own = await chat.uploadAttachment(room.id, b.id, {
			name: 'y.png',
			mime: 'image/png',
			data: png
		});

		// Wrong room.
		await expectChatError(() => chat.send(room.id, a.id, 'hi', [foreign.id]), 422);
		// Right room but alice did not upload it.
		await expectChatError(() => chat.send(room.id, a.id, 'hi', [own.id]), 422);
		// Unknown id.
		await expectChatError(() => chat.send(room.id, a.id, 'hi', ['nope']), 422);
		// A failed claim must not leave a dangling message row.
		expect((await chat.list(room.id, a.id)).messages).toHaveLength(0);
		// The unclaimed upload is still usable by its owner.
		const m = await chat.send(room.id, b.id, 'here', [own.id]);
		expect(m.attachments).toHaveLength(1);

		// The per-message cap holds.
		const ids = Array.from({ length: 11 }, (_, i) => `x${i}`);
		await expectChatError(() => chat.send(room.id, a.id, 'hi', ids), 422);
	});

	it('gates downloads on room membership', async () => {
		const { users, chat } = stores();
		const a = await users.create('alice', 'a-very-long-password', 'operator');
		const b = await users.create('bob', 'a-very-long-password', 'viewer');
		const c = await users.create('carol', 'a-very-long-password', 'viewer');
		const room = await chat.openDm(a.id, b.id);
		// Carol belongs to a different room entirely.
		await chat.createRoom('side', [c.id], c.id);

		const att = await chat.uploadAttachment(room.id, a.id, {
			name: 'spec.pdf',
			mime: 'application/pdf',
			data: new Uint8Array([1, 2, 3, 4])
		});
		await chat.send(room.id, a.id, 'see attached', [att.id]);

		const file = await chat.attachmentDownload(att.id, b.id);
		expect(file.name).toBe('spec.pdf');
		expect(file.mime).toBe('application/pdf');
		expect([...file.data]).toEqual([1, 2, 3, 4]);

		// Members of a different room cannot pull it.
		await expectChatError(() => chat.attachmentDownload(att.id, c.id), 403);
		await expectChatError(() => chat.attachmentDownload('nope', b.id), 404);
	});

	it('tombstones attachments with the message and prunes files later', async () => {
		const { dir, db, users, chat } = stores();
		const a = await users.create('alice', 'a-very-long-password', 'operator');
		const b = await users.create('bob', 'a-very-long-password', 'viewer');
		const room = await chat.openDm(a.id, b.id);

		const att = await chat.uploadAttachment(room.id, a.id, {
			name: 'log.txt',
			mime: 'text/plain',
			data: new Uint8Array([65])
		});
		const m = await chat.send(room.id, a.id, '', [att.id]);
		const key = join(dir, 'chat-attachments', room.id);
		const stored = readdirSync(key)[0];

		// Delete denies download for everyone, including a moderator
		// delete path (moderator flag only widens who may remove).
		await chat.remove(m.id, b.id, true);
		await expectChatError(() => chat.attachmentDownload(att.id, a.id), 410);
		// The tombstoned message serializes without attachment metadata.
		const page = await chat.list(room.id, b.id);
		expect(page.messages.at(-1)?.attachments).toEqual([]);
		// The file survives until the retention sweep.
		expect(existsSync(join(key, stored))).toBe(true);

		// Age the rows past retention and sweep: row and file both go.
		const old = Date.now() - 31 * 86_400_000;
		db.prepare('UPDATE chat_messages SET deleted_at = ? WHERE id = ?').run(old, m.id);
		db.prepare('UPDATE chat_attachments SET deleted_at = ? WHERE id = ?').run(old, att.id);
		expect(await chat.prune()).toBe(1);
		expect(existsSync(join(key, stored))).toBe(false);
		expect(
			db.prepare('SELECT COUNT(*) AS n FROM chat_attachments WHERE id = ?').get(att.id)
		).toEqual({ n: 0 });
	});

	it('sweeps stale unattached uploads', async () => {
		const { dir, db, users, chat } = stores();
		const a = await users.create('alice', 'a-very-long-password', 'operator');
		const b = await users.create('bob', 'a-very-long-password', 'viewer');
		const room = await chat.openDm(a.id, b.id);

		const att = await chat.uploadAttachment(room.id, a.id, {
			name: 'draft.md',
			mime: 'text/markdown',
			data: new Uint8Array([35])
		});
		const key = join(dir, 'chat-attachments', room.id);
		expect(readdirSync(key)).toHaveLength(1);

		// Fresh uploads survive; a stale one is reclaimed.
		db.prepare('UPDATE chat_attachments SET created_at = ? WHERE id = ?').run(
			Date.now() - 25 * 3600_000,
			att.id
		);
		expect(await chat.prune()).toBe(0);
		expect(readdirSync(key)).toHaveLength(0);
		expect(
			db.prepare('SELECT COUNT(*) AS n FROM chat_attachments WHERE id = ?').get(att.id)
		).toEqual({ n: 0 });
	});
});

describe('chat-files helpers', () => {
	it('reduces names to a bounded basename and keys by id', () => {
		expect(cleanFilename('a/b\\c/../../../etc/passwd')).toBe('passwd');
		expect(cleanFilename('   ')).toBe('file');
		expect(cleanFilename('x'.repeat(300))).toHaveLength(128);
		expect(attachmentKey('room1', 'id9', 'report.PDF')).toBe('room1/id9.pdf');
		expect(attachmentKey('room1', 'id9', 'noext')).toBe('room1/id9');
	});

	it('refuses keys that escape the attachments dir', () => {
		expect(attachmentPath('/var/data/chat-attachments', 'r/f.png')).not.toBeNull();
		expect(attachmentPath('/var/data/chat-attachments', '../secret')).toBeNull();
		expect(attachmentPath('/var/data/chat-attachments', 'r/../../x')).toBeNull();
	});
});
