import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { Runtime } from '$lib/server/runtime';
import type { UserStore } from '$lib/server/admin/users';

// Route coverage for the chat attachment endpoints. Real stores on a
// temp db + temp data dir; only the runtime composition is stubbed.
const ref = vi.hoisted(() => ({
	rt: undefined as unknown as Runtime,
	users: undefined as unknown as UserStore
}));

vi.mock('$lib/server/runtime', async () => {
	process.env.WHARFINGER_SECRET_KEY = 'chat-route-test-key';
	const { mkdtempSync } = await import('node:fs');
	const { join } = await import('node:path');
	const { tmpdir } = await import('node:os');
	const dir = mkdtempSync(join(tmpdir(), 'q4s-chat-routes-'));
	process.env.WHARFINGER_DATA_DIR = dir;
	const { openDb } = await import('$lib/server/store/db');
	const { UserStore } = await import('$lib/server/admin/users');
	const { ChatStore } = await import('$lib/server/admin/chat');
	const db = openDb(dir);
	ref.users = new UserStore(db);
	ref.rt = {
		users: ref.users,
		chat: new ChatStore(db, ref.users, dir),
		audit: { log: vi.fn(() => Promise.resolve()) },
		db
	} as unknown as Runtime;
	return { getRuntime: () => ref.rt };
});

const { POST: uploadRoute } =
	await import('../../src/routes/admin/api/chat/rooms/[id]/attachments/+server');
const { GET: downloadRoute } =
	await import('../../src/routes/admin/api/chat/attachments/[id]/+server');
const { POST: sendRoute } =
	await import('../../src/routes/admin/api/chat/rooms/[id]/messages/+server');

// Intersecting the three route event types makes the fake event
// assignable to every chat route handler under test.
type ChatRouteEvent = RequestEvent<{ id: string }, '/admin/api/chat/rooms/[id]/attachments'> &
	RequestEvent<{ id: string }, '/admin/api/chat/attachments/[id]'> &
	RequestEvent<{ id: string }, '/admin/api/chat/rooms/[id]/messages'>;

function event(
	userId: number | null,
	opts: {
		params?: Record<string, string>;
		url: string;
		method?: string;
		body?: BodyInit;
		headers?: Record<string, string>;
	}
): ChatRouteEvent {
	return {
		locals: userId === null ? {} : { user: { id: userId, username: `u${userId}` } },
		params: opts.params ?? {},
		url: new URL(opts.url),
		request: new Request(opts.url, {
			method: opts.method ?? 'GET',
			body: opts.body,
			headers: opts.headers
		}),
		getClientAddress: () => '127.0.0.1'
	} as unknown as ChatRouteEvent;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
let seq = 0;

async function dmPair(): Promise<{ roomId: string; a: number; b: number }> {
	seq += 1;
	const a = await ref.users.create(`alice${seq}`, 'a-very-long-password', 'operator');
	const b = await ref.users.create(`bob${seq}`, 'a-very-long-password', 'viewer');
	const room = await ref.rt.chat.openDm(a.id, b.id);
	return { roomId: room.id, a: a.id, b: b.id };
}

async function outsider(): Promise<number> {
	seq += 1;
	return (await ref.users.create(`carol${seq}`, 'a-very-long-password', 'viewer')).id;
}

function uploadEvent(
	userId: number | null,
	roomId: string,
	name: string,
	mime: string,
	data: Uint8Array<ArrayBuffer>
): ChatRouteEvent {
	const url = `http://test/admin/api/chat/rooms/${roomId}/attachments?filename=${encodeURIComponent(name)}`;
	return event(userId, {
		url,
		method: 'POST',
		params: { id: roomId },
		body: data,
		headers: { 'content-type': mime }
	});
}

describe('chat attachment routes', () => {
	it('rejects unauthenticated calls', async () => {
		const res = downloadRoute(
			event(null, { url: 'http://test/admin/api/chat/attachments/x', params: { id: 'x' } })
		);
		await expect(res).rejects.toMatchObject({ status: 401 });
		await expect(
			uploadRoute(uploadEvent(null, 'room1', 'a.png', 'image/png', PNG))
		).rejects.toMatchObject({ status: 401 });
	});

	it('rejects a disallowed mime and an oversized body', async () => {
		const { roomId, a } = await dmPair();
		const bad = await uploadRoute(uploadEvent(a, roomId, 'a.html', 'text/html', PNG));
		expect(bad.status).toBe(422);
		const badBody = (await bad.json()) as { error?: string };
		expect(badBody.error).toMatch(/unsupported/);

		const big = await uploadRoute(
			uploadEvent(a, roomId, 'big.png', 'image/png', new Uint8Array(10 * 1024 * 1024 + 1))
		);
		expect(big.status).toBe(413);
	});

	it('rejects a non-member upload and a missing filename', async () => {
		const { roomId, a } = await dmPair();
		const out = await outsider();
		const denied = await uploadRoute(uploadEvent(out, roomId, 'a.png', 'image/png', PNG));
		expect(denied.status).toBe(403);

		const noName = await uploadRoute(
			event(a, {
				url: `http://test/admin/api/chat/rooms/${roomId}/attachments`,
				method: 'POST',
				params: { id: roomId },
				body: PNG,
				headers: { 'content-type': 'image/png' }
			})
		);
		expect(noName.status).toBe(422);
	});

	it('uploads, attaches, and downloads with membership enforced', async () => {
		const { roomId, a, b } = await dmPair();
		const out = await outsider();

		const up = await uploadRoute(uploadEvent(a, roomId, 'shot.png', 'image/png', PNG));
		expect(up.status).toBe(201);
		const { attachment } = (await up.json()) as {
			attachment: { id: string; name: string; mime: string; size: number };
		};
		expect(attachment.name).toBe('shot.png');

		const sent = await sendRoute(
			event(a, {
				url: `http://test/admin/api/chat/rooms/${roomId}/messages`,
				method: 'POST',
				params: { id: roomId },
				body: JSON.stringify({ body: '', attachment_ids: [attachment.id] }),
				headers: { 'content-type': 'application/json' }
			})
		);
		expect(sent.status).toBe(201);
		const { message } = (await sent.json()) as {
			message: { id: number; attachments: { id: string }[] };
		};
		expect(message.attachments).toHaveLength(1);
		expect(message.attachments[0].id).toBe(attachment.id);

		const dl = await downloadRoute(
			event(b, {
				url: `http://test/admin/api/chat/attachments/${attachment.id}`,
				params: { id: attachment.id }
			})
		);
		expect(dl.status).toBe(200);
		expect(dl.headers.get('content-type')).toBe('image/png');
		expect(dl.headers.get('content-disposition')).toContain('attachment');
		expect(dl.headers.get('content-disposition')).toContain('shot.png');
		expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
		expect(new Uint8Array(await dl.arrayBuffer())).toEqual(PNG);

		// A user outside the room cannot fetch it.
		const denied = await downloadRoute(
			event(out, {
				url: `http://test/admin/api/chat/attachments/${attachment.id}`,
				params: { id: attachment.id }
			})
		);
		expect(denied.status).toBe(403);

		// Deleting the message cuts download access (410 Gone).
		const gone = await ref.rt.chat.remove(message.id, b, true);
		expect(gone.deletedAt).not.toBeNull();
		const after = await downloadRoute(
			event(b, {
				url: `http://test/admin/api/chat/attachments/${attachment.id}`,
				params: { id: attachment.id }
			})
		);
		expect(after.status).toBe(410);
	});

	it('rejects malformed attachment_ids on send', async () => {
		const { roomId, a } = await dmPair();
		const bad = await sendRoute(
			event(a, {
				url: `http://test/admin/api/chat/rooms/${roomId}/messages`,
				method: 'POST',
				params: { id: roomId },
				body: JSON.stringify({ body: 'hi', attachment_ids: 'not-an-array' }),
				headers: { 'content-type': 'application/json' }
			})
		);
		expect(bad.status).toBe(422);
	});
});
