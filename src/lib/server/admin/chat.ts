import { error, type RequestEvent } from '@sveltejs/kit';
import type { DatabaseSync } from 'node:sqlite';
import { openSecret, randomToken, sealSecret } from './crypto';
import { apiError, requireUser } from './http';
import { asDb, isUniqueViolation, type Db } from '$lib/server/store/driver';
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
	has_avatar: boolean;
	joined_at: number;
}

interface RawMessageRow {
	id: number;
	room_id: string;
	user_id: number;
	body: string;
	at: number;
	edited_at: number | null;
	deleted_at: number | null;
}

interface MessageRow extends RawMessageRow {
	username: string;
	display_name: string;
	has_avatar: boolean;
}

interface UserBrief {
	username: string;
	display_name: string;
	has_avatar: boolean;
}

const ROOM_SELECT = 'SELECT id, kind, name, dm_key, created_by, created_at FROM chat_rooms';
const MESSAGE_SELECT =
	'SELECT id, room_id, user_id, body, at, edited_at, deleted_at FROM chat_messages';

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
			hasAvatar: row.has_avatar,
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
		hasAvatar: row.has_avatar,
		// Sealed bodies that fail to unseal (key rotation, tamper)
		// render as empty rather than leaking ciphertext.
		body: openSecret(row.body) ?? '',
		at: row.at,
		editedAt: row.edited_at,
		deletedAt: null
	};
}

export class ChatStore {
	private readonly db: Db;

	constructor(
		db: Db | DatabaseSync,
		private readonly users: UserStore
	) {
		this.db = asDb(db);
	}

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

	/**
	 * JOIN is outside the portable dialect, so author profile fields
	 * arrive through a second query keyed on user ids.
	 */
	private async userBriefs(userIds: number[]): Promise<Map<number, UserBrief>> {
		const briefs = new Map<number, UserBrief>();
		const ids = [...new Set(userIds)];
		if (ids.length === 0) return briefs;
		const rows = (await this.db
			.prepare(
				`SELECT id, username, display_name, avatar IS NOT NULL AS has_avatar FROM users WHERE id IN (${ids.map(() => '?').join(',')})`
			)
			.all(...ids)) as unknown as {
			id: number;
			username: string;
			display_name: string;
			has_avatar: number | boolean;
		}[];
		for (const r of rows) {
			briefs.set(r.id, {
				username: r.username,
				display_name: r.display_name,
				has_avatar: Boolean(r.has_avatar)
			});
		}
		return briefs;
	}

	/** Attach author fields; rows from deleted users drop out, matching the old inner join. */
	private async hydrateMessages(rows: RawMessageRow[]): Promise<MessageRow[]> {
		const briefs = await this.userBriefs(rows.map((r) => r.user_id));
		const out: MessageRow[] = [];
		for (const r of rows) {
			const brief = briefs.get(r.user_id);
			if (brief === undefined) continue;
			out.push({ ...r, ...brief });
		}
		return out;
	}

	private async roomRow(id: string): Promise<RoomRow | null> {
		return (
			((await this.db.prepare(`${ROOM_SELECT} WHERE id = ?`).get(id)) as RoomRow | undefined) ??
			null
		);
	}

	private async isMember(roomId: string, userId: number): Promise<boolean> {
		return (
			(await this.db
				.prepare('SELECT 1 AS x FROM chat_members WHERE room_id = ? AND user_id = ?')
				.get(roomId, userId)) !== undefined
		);
	}

	private async requireRoom(roomId: string): Promise<RoomRow> {
		const room = await this.roomRow(roomId);
		if (!room) throw new ChatError(404, 'unknown conversation');
		return room;
	}

	private async requireMembership(roomId: string, userId: number): Promise<void> {
		if (!(await this.isMember(roomId, userId))) {
			throw new ChatError(403, 'not a member of this conversation');
		}
	}

	private async membersOf(roomId: string): Promise<MemberRow[]> {
		const members = (await this.db
			.prepare('SELECT user_id, joined_at FROM chat_members WHERE room_id = ?')
			.all(roomId)) as unknown as { user_id: number; joined_at: number }[];
		const briefs = await this.userBriefs(members.map((m) => m.user_id));
		return members
			.flatMap((m) => {
				const b = briefs.get(m.user_id);
				return b ? [{ ...m, ...b }] : [];
			})
			.sort((a, b) => a.username.localeCompare(b.username));
	}

	async memberIds(roomId: string): Promise<number[]> {
		return (
			(await this.db
				.prepare('SELECT user_id FROM chat_members WHERE room_id = ?')
				.all(roomId)) as unknown as { user_id: number }[]
		).map((r) => r.user_id);
	}

	private async messageRow(id: number): Promise<MessageRow | null> {
		const row = (await this.db.prepare(`${MESSAGE_SELECT} WHERE id = ?`).get(id)) as
			RawMessageRow | undefined;
		if (!row) return null;
		const joined = (await this.hydrateMessages([row])).at(0);
		return joined ?? null;
	}

	private async roomInfo(row: RoomRow, userId: number): Promise<ChatRoom> {
		const members: ChatMember[] = (await this.membersOf(row.id)).map((m) => ({
			id: m.user_id,
			username: m.username,
			displayName: m.display_name,
			hasAvatar: m.has_avatar
		}));
		const lastRead = (
			(await this.db
				.prepare('SELECT last_read_id FROM chat_members WHERE room_id = ? AND user_id = ?')
				.get(row.id, userId)) as { last_read_id: number } | undefined
		)?.last_read_id;
		const unread = (
			(await this.db
				.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE room_id = ? AND id > ?')
				.get(row.id, lastRead ?? 0)) as { n: number }
		).n;
		const last = (await this.db
			.prepare(`${MESSAGE_SELECT} WHERE room_id = ? ORDER BY id DESC LIMIT 1`)
			.get(row.id)) as RawMessageRow | undefined;
		let preview: ChatPreview | null = null;
		if (last) {
			const joined = (await this.hydrateMessages([last])).at(0);
			if (joined) {
				const msg = toMessage(joined);
				preview = {
					id: msg.id,
					body: msg.deletedAt !== null ? '' : msg.body.slice(0, PREVIEW_LEN),
					at: msg.at,
					username: msg.username,
					deleted: msg.deletedAt !== null
				};
			}
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
	async listRoomsFor(userId: number): Promise<ChatRoom[]> {
		const memberRows = (await this.db
			.prepare('SELECT room_id FROM chat_members WHERE user_id = ?')
			.all(userId)) as unknown as { room_id: string }[];
		if (memberRows.length === 0) return [];
		const ids = memberRows.map((r) => r.room_id);
		const inList = ids.map(() => '?').join(',');
		const rooms = (await this.db
			.prepare(`${ROOM_SELECT} WHERE id IN (${inList})`)
			.all(...ids)) as unknown as RoomRow[];
		// The correlated MAX subquery that ordered this in sqlite is not
		// portable; last-activity ids come from one grouped scan instead.
		const activity = new Map<string, number>();
		const active = (await this.db
			.prepare(
				`SELECT room_id, MAX(id) AS last_id FROM chat_messages WHERE room_id IN (${inList}) GROUP BY room_id`
			)
			.all(...ids)) as unknown as { room_id: string; last_id: number }[];
		for (const a of active) activity.set(a.room_id, a.last_id);
		rooms.sort(
			(a, b) => (activity.get(b.id) ?? 0) - (activity.get(a.id) ?? 0) || b.created_at - a.created_at
		);
		const out: ChatRoom[] = [];
		for (const r of rooms) out.push(await this.roomInfo(r, userId));
		return out;
	}

	/** Full room view for one member; used after create/join events. */
	async roomInfoFor(roomId: string, userId: number): Promise<ChatRoom> {
		const room = await this.requireRoom(roomId);
		await this.requireMembership(room.id, userId);
		return this.roomInfo(room, userId);
	}

	async createRoom(name: string, memberIds: number[], creatorId: number): Promise<ChatRoom> {
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
			const u = await this.users.byId(id);
			if (u?.disabledAt !== null) throw new ChatError(422, 'unknown or disabled member');
		}
		const now = Date.now();
		const roomId = randomToken(12);
		await this.db.tx(async (tx) => {
			await tx
				.prepare(
					'INSERT INTO chat_rooms (id, kind, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)'
				)
				.run(roomId, 'room', clean, creatorId, now);
			const ins = tx.prepare(
				'INSERT OR IGNORE INTO chat_members (room_id, user_id, joined_at) VALUES (?, ?, ?)'
			);
			for (const id of ids) await ins.run(roomId, id, now);
		});
		const room = await this.requireRoom(roomId);
		return this.roomInfo(room, creatorId);
	}

	/**
	 * Find-or-create the dm between two users. The canonical dm_key
	 * (min:max) plus the UNIQUE constraint makes the insert idempotent;
	 * a concurrent creator loses the race and both callers select the
	 * same row.
	 */
	async openDm(userId: number, otherId: number): Promise<ChatRoom> {
		if (userId === otherId) throw new ChatError(422, 'cannot open a conversation with yourself');
		const other = await this.users.byId(otherId);
		if (other?.disabledAt !== null) {
			throw new ChatError(422, 'unknown or disabled user');
		}
		const key = `${Math.min(userId, otherId)}:${Math.max(userId, otherId)}`;
		const now = Date.now();
		const room = await this.db.tx(async (tx) => {
			let row = (await tx.prepare(`${ROOM_SELECT} WHERE dm_key = ?`).get(key)) as
				RoomRow | undefined;
			if (!row) {
				try {
					await tx
						.prepare(
							'INSERT INTO chat_rooms (id, kind, dm_key, created_by, created_at) VALUES (?, ?, ?, ?, ?)'
						)
						.run(randomToken(12), 'dm', key, userId, now);
				} catch (err) {
					// A racing insert on dm_key loses to the unique index;
					// both sides settle on the existing row.
					if (!isUniqueViolation(err)) throw err;
				}
				row = (await tx.prepare(`${ROOM_SELECT} WHERE dm_key = ?`).get(key)) as RoomRow | undefined;
			}
			if (!row) throw new Error('dm insert/select failed');
			const ins = tx.prepare(
				'INSERT OR IGNORE INTO chat_members (room_id, user_id, joined_at) VALUES (?, ?, ?)'
			);
			await ins.run(row.id, userId, now);
			await ins.run(row.id, otherId, now);
			return row;
		});
		return this.roomInfo(room, userId);
	}

	async send(roomId: string, userId: number, rawBody: string): Promise<ChatMessage> {
		const room = await this.requireRoom(roomId);
		await this.requireMembership(room.id, userId);
		const body = cleanBody(rawBody);
		if (!body) throw new ChatError(422, 'message is empty');
		const r = await this.db
			.prepare('INSERT INTO chat_messages (room_id, user_id, body, at) VALUES (?, ?, ?, ?)')
			.run(room.id, userId, sealSecret(body), Date.now());
		this.touch(userId);
		const row = await this.messageRow(Number(r.lastInsertRowid));
		if (!row) throw new Error('message insert failed');
		return toMessage(row);
	}

	async list(
		roomId: string,
		userId: number,
		beforeId?: number,
		limit = MESSAGE_PAGE
	): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
		const room = await this.requireRoom(roomId);
		await this.requireMembership(room.id, userId);
		const rows = (beforeId === undefined
			? await this.db
					.prepare(`${MESSAGE_SELECT} WHERE room_id = ? ORDER BY id DESC LIMIT ?`)
					.all(room.id, limit + 1)
			: await this.db
					.prepare(`${MESSAGE_SELECT} WHERE room_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
					.all(room.id, beforeId, limit + 1)) as unknown as RawMessageRow[];
		const hasMore = rows.length > limit;
		const page = (await this.hydrateMessages(rows.slice(0, limit))).map(toMessage);
		page.reverse();
		return { messages: page, hasMore };
	}

	async markRead(roomId: string, userId: number, messageId: number): Promise<void> {
		const room = await this.requireRoom(roomId);
		await this.requireMembership(room.id, userId);
		const max = (await this.db
			.prepare('SELECT MAX(id) AS id FROM chat_messages WHERE room_id = ?')
			.get(room.id)) as { id: number | null };
		const clamped = Math.min(messageId, max.id ?? 0);
		await this.db
			.prepare(
				'UPDATE chat_members SET last_read_id = ? WHERE room_id = ? AND user_id = ? AND last_read_id < ?'
			)
			.run(clamped, room.id, userId, clamped);
		this.touch(userId);
	}

	async edit(
		messageId: number,
		userId: number,
		rawBody: string,
		now = Date.now()
	): Promise<ChatMessage> {
		const row = await this.messageRow(messageId);
		if (!row) throw new ChatError(404, 'unknown message');
		if (row.deleted_at !== null) throw new ChatError(410, 'message was deleted');
		if (row.user_id !== userId) throw new ChatError(403, 'only the author can edit a message');
		if (now - row.at > EDIT_WINDOW_MS) {
			throw new ChatError(403, 'the 10 minute edit window has passed');
		}
		const body = cleanBody(rawBody);
		if (!body) throw new ChatError(422, 'message is empty');
		await this.db
			.prepare('UPDATE chat_messages SET body = ?, edited_at = ? WHERE id = ?')
			.run(sealSecret(body), now, messageId);
		const updated = await this.messageRow(messageId);
		if (!updated) throw new Error('message update failed');
		return toMessage(updated);
	}

	/** Soft delete: the author, or a moderator holding users.manage. */
	async remove(
		messageId: number,
		userId: number,
		moderator: boolean,
		now = Date.now()
	): Promise<ChatMessage> {
		const row = await this.messageRow(messageId);
		if (!row) throw new ChatError(404, 'unknown message');
		if (row.user_id !== userId && !moderator) {
			throw new ChatError(403, 'only the author can delete a message');
		}
		if (row.deleted_at === null) {
			await this.db
				.prepare('UPDATE chat_messages SET deleted_at = ? WHERE id = ?')
				.run(now, messageId);
		}
		const updated = await this.messageRow(messageId);
		if (!updated) throw new Error('message delete failed');
		return toMessage(updated);
	}

	async addMember(roomId: string, actorId: number, targetId: number): Promise<void> {
		const room = await this.requireRoom(roomId);
		if (room.kind !== 'room') throw new ChatError(422, 'dm membership is fixed');
		await this.requireMembership(room.id, actorId);
		const target = await this.users.byId(targetId);
		if (target?.disabledAt !== null) {
			throw new ChatError(422, 'unknown or disabled user');
		}
		await this.db
			.prepare('INSERT OR IGNORE INTO chat_members (room_id, user_id, joined_at) VALUES (?, ?, ?)')
			.run(room.id, targetId, Date.now());
	}

	async removeMember(
		roomId: string,
		actorId: number,
		targetId: number,
		actorIsAdmin: boolean
	): Promise<void> {
		const room = await this.requireRoom(roomId);
		if (room.kind !== 'room') throw new ChatError(422, 'dm membership is fixed');
		if (targetId !== actorId && room.created_by !== actorId && !actorIsAdmin) {
			throw new ChatError(403, 'only the room creator or an admin can remove members');
		}
		await this.db
			.prepare('DELETE FROM chat_members WHERE room_id = ? AND user_id = ?')
			.run(room.id, targetId);
	}

	/** Drop soft-deleted message bodies past the retention window. */
	async prune(now = Date.now()): Promise<number> {
		return Number(
			(
				await this.db
					.prepare('DELETE FROM chat_messages WHERE deleted_at IS NOT NULL AND deleted_at < ?')
					.run(now - PRUNE_AGE_MS)
			).changes
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
export async function chatActor(event: RequestEvent, users: UserStore): Promise<User> {
	if (isChatBridge(event)) {
		const id = Number(event.request.headers.get('x-chat-user'));
		const user = Number.isInteger(id) ? await users.byId(id) : null;
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
