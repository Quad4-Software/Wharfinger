import { WebSocketServer } from 'ws';
import { registerChatEmitter, registerChatPresence } from './chat-bus.mjs';

// Chat websocket bridge. Session auth and message writes live in the
// SvelteKit /admin/api/chat routes; this file adapts ws framing to
// loopback HTTP calls carrying the shared internal token (set per
// process in bootstrap-env.mjs) plus an x-chat-user claim, so there is
// a single implementation to audit. The upgrade path is matched by
// suffix and the admin mount prefix is derived from it, so a moved
// admin.base_path keeps working without config plumbing.
//
// Wire protocol (JSON text frames, 8KB cap):
//   upgrade   GET <adminBase>/chat/ws with the wharfinger_admin cookie
//   server -> { type: "ready", user, presence }   presence = {userId: state}
//   client -> { type: "send", room, body }
//   server -> { type: "message", room, message }  to every member socket
//   server -> { type: "update", room, message }   edit/delete fan-out
//   client -> { type: "typing", room }
//   server -> { type: "typing", room, userId, username }
//   client -> { type: "ping" }    server -> { type: "pong" }
//   server -> { type: "presence", states }        diffs only
//   server -> { type: "error", error }

const HANDSHAKE_LIMIT_MAX = 30;
const HANDSHAKE_WINDOW_MS = 60_000;
const MAX_FRAME_BYTES = 8 * 1024;
const MAX_SOCKETS_PER_USER = 8;
const MAX_SOCKETS_TOTAL = 512;
const MAX_INFLIGHT = 8;
const PING_INTERVAL_MS = 30_000;
const AWAY_AFTER_MS = 5 * 60_000;
const PRESENCE_SWEEP_MS = 60_000;
const MEMBER_CACHE_MS = 30_000;
const REQ_TIMEOUT_MS = 10_000;

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

// ws -> { userId, username, adminBase, lastActivity, alive, inFlight }
const sockets = new Map();
// userId -> Set<ws>
const byUser = new Map();
// userId -> last broadcast state, for presence diffs
const lastStates = new Map();
// roomId -> { ids: number[] | null, at }
const memberCache = new Map();
// ip -> { count, resetAt } handshake bucket
const handshakeBuckets = new Map();

const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.WHARFINGER_TRUST_PROXY ?? '');

function token() {
	return process.env.CHAT_INTERNAL_TOKEN ?? '';
}

function clientIp(req) {
	if (TRUST_PROXY) {
		const fwd = req.headers['x-forwarded-for'];
		if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
	}
	return req.socket.remoteAddress ?? 'unknown';
}

function handshakeAllowed(ip, now = Date.now()) {
	let b = handshakeBuckets.get(ip);
	if (!b || b.resetAt <= now) {
		b = { count: 0, resetAt: now + HANDSHAKE_WINDOW_MS };
		handshakeBuckets.set(ip, b);
	}
	b.count += 1;
	if (handshakeBuckets.size > 10_000) handshakeBuckets.clear();
	return b.count <= HANDSHAKE_LIMIT_MAX;
}

async function post(url, body, headers = {}) {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(REQ_TIMEOUT_MS)
	});
	return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function get(url, headers = {}) {
	const res = await fetch(url, {
		headers,
		signal: AbortSignal.timeout(REQ_TIMEOUT_MS)
	});
	return { status: res.status, body: await res.json().catch(() => ({})) };
}

function send(ws, msg) {
	if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastTo(userIds, msg) {
	for (const id of userIds) {
		const set = byUser.get(id);
		if (!set) continue;
		for (const ws of set) send(ws, msg);
	}
}

function broadcastAll(msg) {
	for (const ws of sockets.keys()) send(ws, msg);
}

function userState(userId, now = Date.now()) {
	const set = byUser.get(userId);
	if (!set || set.size === 0) return 'offline';
	for (const ws of set) {
		const meta = sockets.get(ws);
		if (meta && now - meta.lastActivity < AWAY_AFTER_MS) return 'online';
	}
	return 'away';
}

function presenceSnapshot() {
	const states = {};
	for (const userId of byUser.keys()) states[userId] = userState(userId);
	return states;
}

/** Broadcast presence diffs for a user whose state may have changed. */
function presenceDiff(userId) {
	const next = userState(userId);
	if (lastStates.get(userId) === next) return;
	lastStates.set(userId, next);
	broadcastAll({ type: 'presence', states: { [userId]: next } });
}

/** Room member ids with a short cache; null means not a member. */
async function membersFor(meta, roomId) {
	const cached = memberCache.get(roomId);
	if (cached && Date.now() - cached.at < MEMBER_CACHE_MS) return cached.ids;
	const r = await get(`${meta.internalBase}${meta.adminBase}/api/chat/rooms/${roomId}/members`, {
		'x-chat-internal': token(),
		'x-chat-user': String(meta.userId)
	});
	const ids = r.status === 200 && Array.isArray(r.body.members) ? r.body.members : null;
	memberCache.set(roomId, { ids, at: Date.now() });
	return ids;
}

function dropSocket(ws) {
	const meta = sockets.get(ws);
	if (!meta) return;
	sockets.delete(ws);
	const set = byUser.get(meta.userId);
	if (set) {
		set.delete(ws);
		if (set.size === 0) byUser.delete(meta.userId);
	}
	presenceDiff(meta.userId);
}

function dropAll() {
	for (const ws of [...sockets.keys()]) ws.terminate();
}

async function handleFrame(ws, meta, msg) {
	meta.lastActivity = Date.now();
	if (msg?.type === 'ping') {
		send(ws, { type: 'pong' });
		return;
	}
	if (msg?.type === 'typing' && typeof msg.room === 'string' && msg.room.length <= 64) {
		presenceDiff(meta.userId);
		const ids = await membersFor(meta, msg.room).catch(() => null);
		if (!ids || !ids.includes(meta.userId)) return;
		broadcastTo(
			ids.filter((id) => id !== meta.userId),
			{ type: 'typing', room: msg.room, userId: meta.userId, username: meta.username }
		);
		return;
	}
	if (
		msg?.type === 'send' &&
		typeof msg.room === 'string' &&
		msg.room.length <= 64 &&
		typeof msg.body === 'string' &&
		msg.body.length <= 16 * 1024
	) {
		if (meta.inFlight >= MAX_INFLIGHT) {
			send(ws, { type: 'error', error: 'slow down' });
			return;
		}
		meta.inFlight++;
		presenceDiff(meta.userId);
		post(
			`${meta.internalBase}${meta.adminBase}/api/chat/rooms/${msg.room}/messages`,
			{ body: msg.body },
			{ 'x-chat-internal': token(), 'x-chat-user': String(meta.userId) }
		)
			.then((r) => {
				if (r.status !== 201) {
					send(ws, { type: 'error', error: r.body?.error ?? 'send failed' });
					return;
				}
				const members = Array.isArray(r.body.members) ? r.body.members : [meta.userId];
				broadcastTo(members, { type: 'message', room: msg.room, message: r.body.message });
			})
			.catch(() => send(ws, { type: 'error', error: 'server unavailable' }))
			.finally(() => {
				meta.inFlight--;
			});
	}
}

/**
 * Claim an upgrade request targeting <adminBase>/chat/ws. Returns true
 * when the socket was handled. Auth happens before the upgrade: the
 * client cookie is posted to the internal auth endpoint, and a bad
 * session gets a plain 401 instead of a ws handshake.
 */
export function handleChatUpgrade(req, socket, head, internalBase) {
	let pathname;
	try {
		pathname = new URL(req.url ?? '/', 'http://internal').pathname;
	} catch {
		return false;
	}
	if (req.method !== 'GET' || !pathname.endsWith('/chat/ws')) return false;
	const adminBase = pathname.slice(0, -'/chat/ws'.length);
	const ip = clientIp(req);
	if (!handshakeAllowed(ip)) {
		socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
		socket.destroy();
		return true;
	}
	const cookie = req.headers.cookie ?? '';
	post(
		`${internalBase}${adminBase}/api/chat/auth`,
		{},
		{
			'x-chat-internal': token(),
			cookie
		}
	)
		.then((r) => {
			if (r.status !== 200 || typeof r.body?.id !== 'number') {
				socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
				socket.destroy();
				return;
			}
			const userId = r.body.id;
			const existing = byUser.get(userId);
			if (sockets.size >= MAX_SOCKETS_TOTAL || (existing?.size ?? 0) >= MAX_SOCKETS_PER_USER) {
				socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
				socket.destroy();
				return;
			}
			wss.handleUpgrade(req, socket, head, (ws) => {
				const meta = {
					userId,
					username: typeof r.body.username === 'string' ? r.body.username : 'unknown',
					adminBase,
					internalBase,
					lastActivity: Date.now(),
					alive: true,
					inFlight: 0
				};
				sockets.set(ws, meta);
				if (!byUser.has(userId)) byUser.set(userId, new Set());
				byUser.get(userId).add(ws);
				send(ws, { type: 'ready', user: r.body, presence: presenceSnapshot() });
				presenceDiff(userId);
				ws.on('pong', () => {
					meta.alive = true;
				});
				ws.on('message', (data) => {
					let msg;
					try {
						msg = JSON.parse(data.toString());
					} catch {
						return;
					}
					void handleFrame(ws, meta, msg);
				});
				ws.on('close', () => dropSocket(ws));
				ws.on('error', () => dropSocket(ws));
			});
		})
		.catch(() => {
			socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
			socket.destroy();
		});
	return true;
}

/**
 * Wire the chat bus + heartbeat + presence sweep once at startup. The
 * upgrade dispatch itself is registered in server.js alongside the
 * ingress bridge.
 */
export function attachChatWs() {
	registerChatEmitter((event) => {
		if (!event || !Array.isArray(event.members)) return;
		broadcastTo(event.members, {
			type: event.type === 'update' ? 'update' : 'message',
			room: event.room,
			message: event.message
		});
	});
	registerChatPresence(() => presenceSnapshot());

	const heartbeat = setInterval(() => {
		for (const [ws, meta] of sockets) {
			if (!meta.alive) {
				ws.terminate();
				dropSocket(ws);
				continue;
			}
			meta.alive = false;
			if (ws.readyState === ws.OPEN) ws.ping();
		}
	}, PING_INTERVAL_MS);
	heartbeat.unref();

	// Away-state and offline transitions need a sweep because nothing
	// pushes a frame when a user simply goes idle.
	const sweep = setInterval(() => {
		for (const userId of byUser.keys()) presenceDiff(userId);
	}, PRESENCE_SWEEP_MS);
	sweep.unref();
}

export function closeChatWs() {
	dropAll();
}
