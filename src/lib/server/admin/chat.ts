import { error, type RequestEvent } from '@sveltejs/kit';
import type { DatabaseSync } from 'node:sqlite';
import { openSecret, randomToken, sealSecret } from './crypto';
import { apiError, requireUser } from './http';
import type { User, UserStore } from './users';
import type {
	ChatMember,
	ChatMessage,
	ChatPresenceState,
	ChatPreview,
	ChatRoom
} from '$lib/shared/chat';

const CHAT_BODY_MAX = 4000;
const CHAT_NAME_MAX = 80;
const MESSAGE_PAGE = 50;
const EDIT_WINDOW_MS = 10 * 60_000;
const PREVIEW_LEN = 80;
const ROOM_MEMBERS_MIN = 2;
const ROOM_MEMBERS_MAX = 50;
const PRUNE_AGE_MS = 30 * 86_400_000;
// Presence fallback for users without a socket (dev mode, REST
// polling): recent activity reads as online, stale as away.
const ACTIVE_ONLINE_MS = 120_000;
const ACTIVE_AWAY_MS = 15 * 60_000;

export class ChatError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

interface RoomRow {
	id: string;
	kind: string;
	name: string | null;
	dm_key: string | null;
	created_by: number;
	created_at: number;
}

interface MemberRow {
	user_id: number;
	username: string;
	display_name: string;
	has_avatar: number;
	joined_at: number;
}

interface MessageRow {
	id: number;
	room_id: string;
	user_id: number;
	username: string;
	display_name: string;
	has_avatar: number;
	body: string;
	at: number;
	edited_at: number | null;
	deleted_at: number | null;
}

const MESSAGE_SELECT = `SELECT m.id, m.room_id, m.user_id, u.username, u.display_name,
	u.avatar IS NOT NULL AS has_avatar, m.body, m.at, m.edited_at, m.deleted_at
	FROM chat_messages m JOIN users u ON u.id = m.user_id`;

/** Plain text only: drop control chars except newline, cap length. */
function cleanBody(raw: string): string {
	// eslint-disable-next-line no-control-regex
	const stripped = raw.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
	return stripped.trim().slice(0, CHAT_BODY_MAX);
}

function toMessage(row: MessageRow): ChatMessage {
	if (row.deleted_at !== null) {
		return {
			id: row.id,
			roomId: row.room_id,
			userId: row.user_id,
			username: row.username,
			displayName: row.display_name,
			hasAvatar: row.has_avatar === 1,
			body: '',
			at: row.at,
			editedAt: row.edited_at,
			deletedAt: row.deleted_at
		};
	}
	return {
		id: row.id,
		roomId: row.room_id,
		userId: row.user_id,
		username: row.username,
		displayName: row.display_name,
		hasAvatar: row.has_avatar === 1,
		// Sealed bodies that fail to unseal (key rotation, tamper)
		// render as empty rather than leaking ciphertext.
		body: openSecret(row.body) ?? '',
		at: row.at,
		editedAt: row.edited_at,
		deletedAt: null
	};
}

export class ChatStore {
	constructor(
		private readonly db: DatabaseSync,
		private readonly users: UserStore
	) {}

	// Last-activity timestamps for the REST fallback presence path.
	// Socket-derived presence (the production bridge) wins over this.
	private readonly lastActive = new Map<number, number>();

	touch(userId: number, now = Date.now()): void {
		this.lastActive.set(userId, now);
	}

	presenceFor(userId: number, now = Date.now()): ChatPresenceState {
		const at = this.lastActive.get(userId);
		if (at === undefined) return 'offline';
		if (now - at < ACTIVE_ONLINE_MS) return 'online';
		if (now - at < ACTIVE_AWAY_MS) return 'away';
		return 'offline';
	}

	private roomRow(id: string): RoomRow | null {
		return (
			(this.db
				.prepare(
					'SELECT id, kind, name, dm_key, created_by, created_at FROM chat_rooms WHERE id = ?'
				)
				.get(id) as RoomRow | undefined) ?? null
		);
	}

	private isMember(roomId: string, userId: number): boolean {
		return (
			this.db
				.prepare('SELECT 1 AS x FROM chat_members WHERE room_id = ? AND user_id = ?')
				.get(roomId, userId) !== undefined
		);
	}

	private requireRoom(roomId: string): RoomRow {
		const room = this.roomRow(roomId);
		if (!room) throw new ChatError(404, 'unknown conversation');
		return room;
	}

	private requireMembership(roomId: string, userId: number): void {
		if (!this.isMember(roomId, userId)) {
			throw new ChatError(403, 'not a member of this conversation');
		}
	}

	private membersOf(roomId: string): MemberRow[] {
		return this.db
			.prepare(
				`SELECT m.user_id, u.username, u.display_name, u.avatar IS NOT NULL AS has_avatar, m.joined_at
				FROM chat_members m JOIN users u ON u.id = m.user_id
				WHERE m.room_id = ? ORDER BY u.username`
			)
			.all(roomId) as unknown as MemberRow[];
	}

	memberIds(roomId: string): number[] {
		return (
			this.db
				.prepare('SELECT user_id FROM chat_members WHERE room_id = ?')
				.all(roomId) as unknown as { user_id: number }[]
		).map((r) => r.user_id);
	}

	private messageRow(id: number): MessageRow | null {
		return (
			(this.db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id) as MessageRow | undefined) ??
			null
		);
	}

	private roomInfo(row: RoomRow, userId: number): ChatRoom {
		const members: ChatMember[] = this.membersOf(row.id).map((m) => ({
			id: m.user_id,
			username: m.username,
			displayName: m.display_name,
			hasAvatar: m.has_avatar === 1
		}));
		const lastRead = (
			this.db
				.prepare('SELECT last_read_id FROM chat_members WHERE room_id = ? AND user_id = ?')
				.get(row.id, userId) as { last_read_id: number } | undefined
		)?.last_read_id;
		const unread = (
			this.db
				.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE room_id = ? AND id > ?')
				.get(row.id, lastRead ?? 0) as { n: number }
		).n;
		const last = this.db
			.prepare(`${MESSAGE_SELECT} WHERE m.room_id = ? ORDER BY m.id DESC LIMIT 1`)
			.get(row.id) as MessageRow | undefined;
		let preview: ChatPreview | null = null;
		if (last) {
			const msg = toMessage(last);
			preview = {
				id: msg.id,
				body: msg.deletedAt !== null ? '' : msg.body.slice(0, PREVIEW_LEN),
				at: msg.at,
				username: msg.username,
				deleted: msg.deletedAt !== null
			};
		}
		return {
			id: row.id,
			kind: row.kind === 'dm' ? 'dm' : 'room',
			name: row.name ?? '',
			createdBy: row.created_by,
			createdAt: row.created_at,
			members,
			unread,
			preview
		};
	}

	/** Rooms the user belongs to, most recently active first. */
	listRoomsFor(userId: number): ChatRoom[] {
		const rows = this.db
			.prepare(
				`SELECT r.id, r.kind, r.name, r.dm_key, r.created_by, r.created_at
				FROM chat_rooms r JOIN chat_members m ON m.room_id = r.id
				WHERE m.user_id = ?
				ORDER BY COALESCE((SELECT MAX(cm.id) FROM chat_messages cm WHERE cm.room_id = r.id), 0) DESC,
					r.created_at DESC`
			)
			.all(userId) as unknown as RoomRow[];
		return rows.map((r) => this.roomInfo(r, userId));
	}

	/** Full room view for one member; used after create/join events. */
	roomInfoFor(roomId: string, userId: number): ChatRoom {
		const room = this.requireRoom(roomId);
		this.requireMembership(room.id, userId);
		return this.roomInfo(room, userId);
	}

	createRoom(name: string, memberIds: number[], creatorId: number): ChatRoom {
		const clean = name.trim().slice(0, CHAT_NAME_MAX);
		if (!clean) throw new ChatError(422, 'a room name is required');
		const ids = [...new Set([creatorId, ...memberIds])];
		if (ids.length < ROOM_MEMBERS_MIN || ids.length > ROOM_MEMBERS_MAX) {
			throw new ChatError(
				422,
				`rooms need between ${ROOM_MEMBERS_MIN} and ${ROOM_MEMBERS_MAX} members`
			);
		}
		for (const id of ids) {
			const u = this.users.byId(id);
			if (u?.disabledAt !== null) throw new ChatError(422, 'unknown or disabled member');
		}
		const now = Date.now();
		const roomId = randomToken(12);
		this.db.exec('BEGIN IMMEDIATE');
		try {
			this.db
				.prepare(
					'INSERT INTO chat_rooms (id, kind, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)'
				)
				.run(roomId, 'room', clean, creatorId, now);
			const ins = this.db.prepare(
				'INSERT OR IGNORE INTO chat_members (room_id, user_id, joined_at) VALUES (?, ?, ?)'
			);
			for (const id of ids) ins.run(roomId, id, now);
			this.db.exec('COMMIT');
		} catch (err) {
			try {
				this.db.exec('ROLLBACK');
			} catch {
				// already rolled back
			}
			throw err;
		}
		return this.roomInfo(this.requireRoom(roomId), creatorId);
	}

	/**
	 * Find-or-create the dm between two users. The canonical dm_key
	 * (min:max) plus the UNIQUE constraint makes the insert idempotent;
	 * a concurrent creator loses the race and both callers select the
	 * same row.
	 */
	openDm(userId: number, otherId: number): ChatRoom {
		if (userId === otherId) throw new ChatError(422, 'cannot open a conversation with yourself');
		const other = this.users.byId(otherId);
		if (other?.disabledAt !== null) {
			throw new ChatError(422, 'unknown or disabled user');
		}
		const key = `${Math.min(userId, otherId)}:${Math.max(userId, otherId)}`;
		const now = Date.now();
		this.db.exec('BEGIN IMMEDIATE');
		try {
			this.db
				.prepare(
					'INSERT OR IGNORE INTO chat_rooms (id, kind, dm_key, created_by, created_at) VALUES (?, ?, ?, ?, ?)'
				)
				.run(randomToken(12), 'dm', key, userId, now);
			const row = this.db
				.prepare(
					'SELECT id, kind, name, dm_key, created_by, created_at FROM chat_rooms WHERE dm_key = ?'
				)
				.get(key) as RoomRow | undefined;
			if (!row) throw new Error('dm insert/select failed');
			const ins = this.db.prepare(
				'INSERT OR IGNORE INTO chat_members (room_id, user_id, joined_at) VALUES (?, ?, ?)'
			);
			ins.run(row.id, userId, now);
			ins.run(row.id, otherId, now);
			this.db.exec('COMMIT');
			return this.roomInfo(row, userId);
		} catch (err) {
			try {
				this.db.exec('ROLLBACK');
			} catch {
				// already rolled back
			}
			throw err;
		}
	}

	send(roomId: string, userId: number, rawBody: string): ChatMessage {
		const room = this.requireRoom(roomId);
		this.requireMembership(room.id, userId);
		const body = cleanBody(rawBody);
		if (!body) throw new ChatError(422, 'message is empty');
		const r = this.db
			.prepare('INSERT INTO chat_messages (room_id, user_id, body, at) VALUES (?, ?, ?, ?)')
			.run(room.id, userId, sealSecret(body), Date.now());
		this.touch(userId);
		const row = this.messageRow(Number(r.lastInsertRowid));
		if (!row) throw new Error('message insert failed');
		return toMessage(row);
	}

	list(
		roomId: string,
		userId: number,
		beforeId?: number,
		limit = MESSAGE_PAGE
	): { messages: ChatMessage[]; hasMore: boolean } {
		const room = this.requireRoom(roomId);
		this.requireMembership(room.id, userId);
		const rows =
			beforeId === undefined
				? (this.db
						.prepare(`${MESSAGE_SELECT} WHERE m.room_id = ? ORDER BY m.id DESC LIMIT ?`)
						.all(room.id, limit + 1) as unknown as MessageRow[])
				: (this.db
						.prepare(
							`${MESSAGE_SELECT} WHERE m.room_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`
						)
						.all(room.id, beforeId, limit + 1) as unknown as MessageRow[]);
		const hasMore = rows.length > limit;
		const page = rows.slice(0, limit).map(toMessage);
		page.reverse();
		return { messages: page, hasMore };
	}

	markRead(roomId: string, userId: number, messageId: number): void {
		const room = this.requireRoom(roomId);
		this.requireMembership(room.id, userId);
		const max = this.db
			.prepare('SELECT MAX(id) AS id FROM chat_messages WHERE room_id = ?')
			.get(room.id) as { id: number | null };
		const clamped = Math.min(messageId, max.id ?? 0);
		this.db
			.prepare(
				'UPDATE chat_members SET last_read_id = ? WHERE room_id = ? AND user_id = ? AND last_read_id < ?'
			)
			.run(clamped, room.id, userId, clamped);
		this.touch(userId);
	}

	edit(messageId: number, userId: number, rawBody: string, now = Date.now()): ChatMessage {
		const row = this.messageRow(messageId);
		if (!row) throw new ChatError(404, 'unknown message');
		if (row.deleted_at !== null) throw new ChatError(410, 'message was deleted');
		if (row.user_id !== userId) throw new ChatError(403, 'only the author can edit a message');
		if (now - row.at > EDIT_WINDOW_MS) {
			throw new ChatError(403, 'the 10 minute edit window has passed');
		}
		const body = cleanBody(rawBody);
		if (!body) throw new ChatError(422, 'message is empty');
		this.db
			.prepare('UPDATE chat_messages SET body = ?, edited_at = ? WHERE id = ?')
			.run(sealSecret(body), now, messageId);
		const updated = this.messageRow(messageId);
		if (!updated) throw new Error('message update failed');
		return toMessage(updated);
	}

	/** Soft delete: the author, or a moderator holding users.manage. */
	remove(messageId: number, userId: number, moderator: boolean, now = Date.now()): ChatMessage {
		const row = this.messageRow(messageId);
		if (!row) throw new ChatError(404, 'unknown message');
		if (row.user_id !== userId && !moderator) {
			throw new ChatError(403, 'only the author can delete a message');
		}
		if (row.deleted_at === null) {
			this.db.prepare('UPDATE chat_messages SET deleted_at = ? WHERE id = ?').run(now, messageId);
		}
		const updated = this.messageRow(messageId);
		if (!updated) throw new Error('message delete failed');
		return toMessage(updated);
	}

	addMember(roomId: string, actorId: number, targetId: number): void {
		const room = this.requireRoom(roomId);
		if (room.kind !== 'room') throw new ChatError(422, 'dm membership is fixed');
		this.requireMembership(room.id, actorId);
		const target = this.users.byId(targetId);
		if (target?.disabledAt !== null) {
			throw new ChatError(422, 'unknown or disabled user');
		}
		this.db
			.prepare('INSERT OR IGNORE INTO chat_members (room_id, user_id, joined_at) VALUES (?, ?, ?)')
			.run(room.id, targetId, Date.now());
	}

	removeMember(roomId: string, actorId: number, targetId: number, actorIsAdmin: boolean): void {
		const room = this.requireRoom(roomId);
		if (room.kind !== 'room') throw new ChatError(422, 'dm membership is fixed');
		if (targetId !== actorId && room.created_by !== actorId && !actorIsAdmin) {
			throw new ChatError(403, 'only the room creator or an admin can remove members');
		}
		this.db
			.prepare('DELETE FROM chat_members WHERE room_id = ? AND user_id = ?')
			.run(room.id, targetId);
	}

	/** Drop soft-deleted message bodies past the retention window. */
	prune(now = Date.now()): number {
		return Number(
			this.db
				.prepare('DELETE FROM chat_messages WHERE deleted_at IS NOT NULL AND deleted_at < ?')
				.run(now - PRUNE_AGE_MS).changes
		);
	}
}

/** Socket-peer loopback check; forwarded headers are never consulted. */
function loopbackPeer(event: RequestEvent): boolean {
	try {
		const a = event.getClientAddress();
		return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
	} catch {
		return false;
	}
}

/**
 * True when the request comes from the in-process ws bridge: a
 * loopback socket peer plus the per-process shared token. The token is
 * generated in server/bootstrap-env.mjs, so it is unset (and every
 * check fails closed) in dev mode and tests.
 */
export function isChatBridge(event: RequestEvent): boolean {
	const token = process.env.CHAT_INTERNAL_TOKEN;
	if (!token || event.request.headers.get('x-chat-internal') !== token) return false;
	return loopbackPeer(event);
}

/** Internal endpoints the bridge alone may call (loopback + token). */
export function requireChatBridge(event: RequestEvent): void {
	if (!isChatBridge(event)) error(403, 'internal endpoint');
}

/**
 * Resolve the acting chat user. Normal panel requests authenticate by
 * session cookie; bridge-forwarded frames carry the x-chat-user id
 * claim, which is only honored on a verified loopback+token request.
 */
export function chatActor(event: RequestEvent, users: UserStore): User {
	if (isChatBridge(event)) {
		const id = Number(event.request.headers.get('x-chat-user'));
		const user = Number.isInteger(id) ? users.byId(id) : null;
		if (user?.disabledAt !== null) error(401, 'invalid bridge user');
		return user;
	}
	return requireUser(event);
}

/** Map a ChatError to its apiError response; rethrows anything else. */
export function chatFail(err: unknown): Response {
	if (err instanceof ChatError) return apiError(err.status, err.message);
	throw err;
}
