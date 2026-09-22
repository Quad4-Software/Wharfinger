<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { page } from '$app/state';
	import {
		ArrowLeft,
		Check,
		CheckCheck,
		Copy,
		Download,
		FileText,
		Hash,
		Image as ImageIcon,
		LoaderCircle,
		LogOut,
		MessageSquare,
		Paperclip,
		Pencil,
		Search,
		Send,
		Trash,
		UserPlus,
		Users,
		X
	} from '@lucide/svelte';
	import Modal from '$lib/components/admin/Modal.svelte';
	import ConfirmDialog from '$lib/components/admin/ConfirmDialog.svelte';
	import ContextMenu, { type CtxItem } from '$lib/components/admin/ContextMenu.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import ChatAvatar from '$lib/components/admin/ChatAvatar.svelte';
	import { adminHref, api, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import { setChatUnread } from '$lib/state/chat.svelte';
	import { notifyLocal } from '$lib/state/push-notify.svelte';
	import { fmtBytes, relativeTime } from '$lib/utils/format';
	import type {
		ChatAttachment,
		ChatMember,
		ChatMessage,
		ChatPeer,
		ChatPresenceMap,
		ChatPresenceState,
		ChatRoom
	} from '$lib/shared/chat';
	import type { PublicUser as User } from '$lib/shared/auth';

	const { data }: { data: { user: User; perms: string[] } } = $props();
	const me = $derived(data.user);
	const canModerate = $derived(data.perms.includes('users.manage'));

	const BODY_MAX = 4000;
	const EDIT_WINDOW_MS = 10 * 60_000;
	const GROUP_MS = 5 * 60_000;
	const TYPING_TTL_MS = 4000;
	const TYPING_SEND_MS = 3000;
	const POLL_MS = 4000;
	const WS_RETRY_MS = 15_000;

	let rooms = $state<ChatRoom[]>([]);
	let presence = $state<ChatPresenceMap>({});
	let peers = $state<ChatPeer[]>([]);
	let openId = $state<string | null>(null);
	let messages = $state<ChatMessage[]>([]);
	let hasMore = $state(false);
	let loadingRooms = $state(true);
	let loadingMsgs = $state(false);
	let loadingOlder = $state(false);
	let filter = $state('');
	let draft = $state('');
	let sending = $state(false);
	let wsLive = $state(false);
	let showRail = $state(true);
	// key `${roomId}:${userId}` -> expiry timestamp
	let typing = $state<Record<string, number>>({});

	let newChatOpen = $state(false);
	let newRoomOpen = $state(false);
	let membersOpen = $state(false);
	let roomName = $state('');
	let roomPicks = $state<number[]>([]);
	let addPick = $state(0);
	let editId = $state<number | null>(null);
	let editDraft = $state('');
	let deleteTarget = $state<ChatMessage | null>(null);
	let deleteOpen = $state(false);
	let leaveOpen = $state(false);
	// Room id the leave confirmation targets; null means the open room.
	let leaveTargetId = $state<string | null>(null);
	let busy = $state(false);
	let memberFilter = $state('');
	let dragOver = $state(false);
	let menu = $state<{ x: number; y: number; items: CtxItem[] } | null>(null);
	let lightbox = $state<{ url: string; name: string; size: number } | null>(null);

	let listEl = $state<HTMLDivElement | null>(null);
	let composerEl = $state<HTMLTextAreaElement | null>(null);
	let fileInputEl = $state<HTMLInputElement | null>(null);
	// Attachments staged for the next send; ids come from the upload API.
	let pendingFiles = $state<ChatAttachment[]>([]);
	// Local object URLs for staged image previews, keyed by attachment id.
	const pendingBlobs = new SvelteMap<string, string>();
	let uploading = $state(false);
	let ws: WebSocket | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let clockTimer: ReturnType<typeof setInterval> | null = null;
	let lastTypingSent = 0;
	let destroyed = false;
	// Ticks every 30s so relative timestamps age without a refresh.
	let now = $state(Date.now());
	// Highest message id already acknowledged per room, so markRead
	// posts once per watermark instead of once per incoming frame.
	const readSent = new SvelteMap<string, number>();
	// Attachment previews come from fetch->blob because the download
	// route serves content-disposition: attachment, which img cannot
	// render. The map holds every object URL for revocation.
	type Thumb = { state: 'loading' | 'err' } | { state: 'ok'; url: string };
	const thumbs = new SvelteMap<string, Thumb>();

	const openRoom = $derived(rooms.find((r) => r.id === openId) ?? null);

	function otherOf(room: ChatRoom): ChatMember | undefined {
		return room.members.find((m) => m.id !== me.id) ?? room.members[0];
	}

	function roomTitle(room: ChatRoom): string {
		if (room.kind === 'dm') {
			const o = otherOf(room);
			return o ? o.displayName || o.username : 'Direct message';
		}
		return room.name || 'Room';
	}

	function memberName(id: number): string {
		for (const r of rooms) {
			const m = r.members.find((x) => x.id === id);
			if (m) return m.displayName || m.username;
		}
		const p = peers.find((x) => x.id === id);
		return p ? p.displayName || p.username : `user ${id}`;
	}

	function presenceOf(id: number): ChatPresenceState {
		return presence[String(id)] ?? 'offline';
	}

	const filteredRooms = $derived(
		filter.trim()
			? rooms.filter((r) => {
					const q = filter.trim().toLowerCase();
					if (roomTitle(r).toLowerCase().includes(q)) return true;
					return r.members.some(
						(m) => m.username.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q)
					);
				})
			: rooms
	);

	const onlineCount = $derived(
		openRoom
			? openRoom.members.filter((m) => m.id !== me.id && presenceOf(m.id) === 'online').length
			: 0
	);

	const memberCandidates = $derived(
		openRoom ? peers.filter((p) => !openRoom.members.some((m) => m.id === p.id)) : []
	);

	const visibleMembers = $derived.by(() => {
		if (!openRoom) return [];
		const q = memberFilter.trim().toLowerCase();
		if (!q) return openRoom.members;
		return openRoom.members.filter(
			(m) => m.username.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q)
		);
	});

	const typingNames = $derived.by(() => {
		if (!openId) return [];
		const now = Date.now();
		const names: string[] = [];
		for (const [key, exp] of Object.entries(typing)) {
			if (exp <= now) continue;
			const [roomId, userId] = key.split(':');
			if (roomId !== openId) continue;
			const id = Number(userId);
			if (id === me.id) continue;
			names.push(memberName(id));
		}
		return names;
	});

	function syncUnread(): void {
		setChatUnread(rooms.reduce((n, r) => n + r.unread, 0));
	}

	async function loadRooms(): Promise<void> {
		try {
			const r = await api<{ rooms: ChatRoom[]; presence: ChatPresenceMap }>('/chat');
			rooms = r.rooms;
			presence = { ...presence, ...r.presence };
			syncUnread();
		} catch (err) {
			toast('error', errMessage(err, 'chat load failed'));
		} finally {
			loadingRooms = false;
		}
	}

	async function loadPeers(): Promise<void> {
		try {
			const r = await api<{ peers: ChatPeer[] }>('/chat/peers');
			peers = r.peers;
		} catch {
			// Non-fatal: the new-chat modal just shows an empty list.
		}
	}

	function mergeMessages(incoming: ChatMessage[]): void {
		if (incoming.length === 0) return;
		const map = new SvelteMap(messages.map((m) => [m.id, m]));
		for (const m of incoming) map.set(m.id, m);
		messages = [...map.values()].sort((a, b) => a.id - b.id);
	}

	async function loadMessages(roomId: string): Promise<void> {
		loadingMsgs = true;
		messages = [];
		try {
			const r = await api<{ messages: ChatMessage[]; hasMore: boolean }>(
				`/chat/rooms/${roomId}/messages`
			);
			messages = r.messages;
			hasMore = r.hasMore;
			await tick();
			scrollBottom();
		} catch (err) {
			toast('error', errMessage(err, 'history failed'));
		} finally {
			loadingMsgs = false;
		}
	}

	async function loadOlder(): Promise<void> {
		if (!openId || loadingOlder || messages.length === 0) return;
		loadingOlder = true;
		const el = listEl;
		const prevHeight = el?.scrollHeight ?? 0;
		try {
			const r = await api<{ messages: ChatMessage[]; hasMore: boolean }>(
				`/chat/rooms/${openId}/messages?before=${messages[0].id}`
			);
			messages = [...r.messages, ...messages];
			hasMore = r.hasMore;
			await tick();
			if (el) el.scrollTop = el.scrollHeight - prevHeight;
		} catch (err) {
			toast('error', errMessage(err, 'history failed'));
		} finally {
			loadingOlder = false;
		}
	}

	async function pollMessages(): Promise<void> {
		if (!openId) return;
		try {
			const r = await api<{ messages: ChatMessage[]; hasMore: boolean }>(
				`/chat/rooms/${openId}/messages`
			);
			const before = messages.length;
			mergeMessages(r.messages);
			if (messages.length !== before) {
				await tick();
				scrollBottom();
				void markRead();
			}
		} catch {
			// polling failure is silent; the ws/retry loop keeps state honest
		}
	}

	function scrollBottom(): void {
		listEl?.scrollTo({ top: listEl.scrollHeight });
	}

	async function markRead(): Promise<void> {
		if (!openId || messages.length === 0) return;
		await postRead(openId, messages[messages.length - 1].id);
	}

	// Read cursor for a room that may not be open: the rail preview id
	// is the newest message the server knows about.
	async function markReadRoom(room: ChatRoom): Promise<void> {
		if (!room.preview) return;
		await postRead(room.id, room.preview.id);
	}

	async function postRead(roomId: string, last: number): Promise<void> {
		if ((readSent.get(roomId) ?? 0) >= last) return;
		readSent.set(roomId, last);
		try {
			await api(`/chat/rooms/${roomId}/read`, { body: { messageId: last } });
			const room = rooms.find((r) => r.id === roomId);
			if (room) {
				room.unread = 0;
				syncUnread();
			}
		} catch {
			readSent.delete(roomId);
		}
	}

	function clearPending(): void {
		for (const url of pendingBlobs.values()) URL.revokeObjectURL(url);
		pendingBlobs.clear();
		pendingFiles = [];
	}

	function revokeThumbs(): void {
		for (const t of thumbs.values()) {
			if (t.state === 'ok') URL.revokeObjectURL(t.url);
		}
		thumbs.clear();
		lightbox = null;
	}

	async function open(roomId: string): Promise<void> {
		openId = roomId;
		showRail = false;
		editId = null;
		draft = '';
		memberFilter = '';
		clearPending();
		await loadMessages(roomId);
		await markRead();
		composerEl?.focus();
	}

	async function send(): Promise<void> {
		const body = draft.trim();
		const attachmentIds = pendingFiles.map((f) => f.id);
		if ((!body && attachmentIds.length === 0) || !openId || sending || uploading) return;
		sending = true;
		try {
			if (wsLive && ws?.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: 'send', room: openId, body, attachments: attachmentIds }));
			} else {
				const r = await api<{ message: ChatMessage }>(`/chat/rooms/${openId}/messages`, {
					body: { body, attachment_ids: attachmentIds }
				});
				mergeMessages([r.message]);
				await tick();
				scrollBottom();
			}
			draft = '';
			clearPending();
		} catch (err) {
			toast('error', errMessage(err, 'send failed'));
		} finally {
			sending = false;
		}
	}

	async function uploadFiles(files: FileList | null): Promise<void> {
		if (!files || !openId) return;
		uploading = true;
		try {
			for (const file of Array.from(files)) {
				const r = await api<{ attachment: ChatAttachment }>(
					`/chat/rooms/${openId}/attachments?filename=${encodeURIComponent(file.name)}`,
					{ method: 'POST', rawBody: file }
				);
				pendingFiles = [...pendingFiles, r.attachment];
				if (file.type.startsWith('image/')) {
					pendingBlobs.set(r.attachment.id, URL.createObjectURL(file));
				}
			}
		} catch (err) {
			toast('error', errMessage(err, 'upload failed'));
		} finally {
			uploading = false;
			if (fileInputEl) fileInputEl.value = '';
		}
	}

	function removePending(id: string): void {
		const url = pendingBlobs.get(id);
		if (url) {
			URL.revokeObjectURL(url);
			pendingBlobs.delete(id);
		}
		pendingFiles = pendingFiles.filter((x) => x.id !== id);
	}

	function onComposerPaste(e: ClipboardEvent): void {
		const files = e.clipboardData?.files;
		if (files && files.length > 0) {
			e.preventDefault();
			void uploadFiles(files);
		}
	}

	function hasDropFiles(e: DragEvent): boolean {
		return e.dataTransfer?.types.includes('Files') ?? false;
	}

	function onDragOver(e: DragEvent): void {
		if (!hasDropFiles(e)) return;
		e.preventDefault();
		dragOver = true;
	}

	// dragleave also fires between children; only clear when the
	// pointer truly leaves the drop zone.
	function onDragLeave(e: DragEvent): void {
		if (!hasDropFiles(e)) return;
		const to = e.relatedTarget;
		const el = e.currentTarget as HTMLElement;
		if (!(to instanceof Node) || !el.contains(to)) dragOver = false;
	}

	function onDrop(e: DragEvent): void {
		if (!hasDropFiles(e)) return;
		e.preventDefault();
		dragOver = false;
		void uploadFiles(e.dataTransfer?.files ?? null);
	}

	function onComposerKey(e: KeyboardEvent): void {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void send();
		}
	}

	function onComposerInput(): void {
		if (!wsLive || !openId || ws?.readyState !== WebSocket.OPEN) return;
		const now = Date.now();
		if (now - lastTypingSent < TYPING_SEND_MS) return;
		lastTypingSent = now;
		ws.send(JSON.stringify({ type: 'typing', room: openId }));
	}

	function bumpRoom(m: ChatMessage): void {
		const room = rooms.find((r) => r.id === m.roomId);
		if (!room) {
			void loadRooms();
			return;
		}
		room.preview = {
			id: m.id,
			body: m.body.slice(0, 80),
			at: m.at,
			username: m.username,
			deleted: m.deletedAt !== null
		};
		if (m.userId !== me.id && (openId !== m.roomId || document.hidden)) room.unread += 1;
		// Activity reorders the rail like the server query does.
		rooms = [room, ...rooms.filter((r) => r.id !== room.id)];
		syncUnread();
	}

	function applyIncoming(m: ChatMessage): void {
		bumpRoom(m);
		if (openId === m.roomId) {
			mergeMessages([m]);
			void tick().then(scrollBottom);
			if (!document.hidden) void markRead();
		}
		if (m.userId !== me.id && (openId !== m.roomId || document.hidden)) {
			const body = m.body || m.attachments[0]?.name || 'attachment';
			const preview = body.length > 60 ? `${body.slice(0, 60)}...` : body;
			toast('info', `${m.displayName || m.username}: ${preview}`);
			if (document.hidden) notifyLocal(m.displayName || m.username, preview);
		}
	}

	function applyUpdate(m: ChatMessage): void {
		if (openId === m.roomId) mergeMessages([m]);
		const room = rooms.find((r) => r.id === m.roomId);
		if (room?.preview?.id === m.id) {
			room.preview = {
				id: m.id,
				body: m.deletedAt !== null ? '' : m.body.slice(0, 80),
				at: m.at,
				username: m.username,
				deleted: m.deletedAt !== null
			};
		}
	}

	interface WsFrame {
		type: string;
		user?: User;
		presence?: ChatPresenceMap;
		states?: ChatPresenceMap;
		room?: string;
		message?: ChatMessage;
		userId?: number;
		username?: string;
		error?: string;
	}

	function onFrame(raw: WsFrame): void {
		switch (raw.type) {
			case 'ready':
				wsLive = true;
				if (raw.presence) presence = { ...presence, ...raw.presence };
				void loadRooms();
				break;
			case 'message':
				if (raw.message) applyIncoming(raw.message);
				break;
			case 'update':
				if (raw.message) applyUpdate(raw.message);
				break;
			case 'presence':
				if (raw.states) presence = { ...presence, ...raw.states };
				break;
			case 'typing':
				if (raw.room && raw.userId !== undefined && raw.userId !== me.id) {
					typing = { ...typing, [`${raw.room}:${raw.userId}`]: Date.now() + TYPING_TTL_MS };
				}
				break;
			case 'error':
				if (raw.error) toast('error', raw.error);
				break;
		}
	}

	function connect(): void {
		if (destroyed) return;
		const proto = location.protocol === 'https:' ? 'wss' : 'ws';
		let sock: WebSocket;
		try {
			sock = new WebSocket(`${proto}://${location.host}${adminHref('/chat/ws')}`);
		} catch {
			return;
		}
		ws = sock;
		sock.onmessage = (e) => {
			try {
				onFrame(JSON.parse(e.data as string) as WsFrame);
			} catch {
				// ignore malformed frames
			}
		};
		sock.onclose = () => {
			if (ws === sock) ws = null;
			wsLive = false;
			if (!destroyed && retryTimer === null) {
				retryTimer = setTimeout(() => {
					retryTimer = null;
					connect();
				}, WS_RETRY_MS);
			}
		};
		sock.onerror = () => {
			sock.close();
		};
	}

	async function startDm(peerId: number): Promise<void> {
		try {
			const r = await api<{ room: ChatRoom }>('/chat/dm', { body: { userId: peerId } });
			newChatOpen = false;
			if (!rooms.some((x) => x.id === r.room.id)) rooms = [r.room, ...rooms];
			await open(r.room.id);
		} catch (err) {
			toast('error', errMessage(err, 'could not open chat'));
		}
	}

	async function createRoom(): Promise<void> {
		if (!roomName.trim() || busy) return;
		busy = true;
		try {
			const r = await api<{ room: ChatRoom }>('/chat/rooms', {
				body: { name: roomName.trim(), members: roomPicks }
			});
			newRoomOpen = false;
			roomName = '';
			roomPicks = [];
			rooms = [r.room, ...rooms.filter((x) => x.id !== r.room.id)];
			await open(r.room.id);
		} catch (err) {
			toast('error', errMessage(err, 'could not create room'));
		} finally {
			busy = false;
		}
	}

	async function addMember(): Promise<void> {
		if (!openId || !addPick) return;
		try {
			const r = await api<{ room: ChatRoom }>(`/chat/rooms/${openId}/members`, {
				body: { userId: addPick }
			});
			const i = rooms.findIndex((x) => x.id === openId);
			if (i !== -1) rooms[i] = r.room;
			addPick = 0;
		} catch (err) {
			toast('error', errMessage(err, 'could not add member'));
		}
	}

	async function removeMember(roomId: string, target: number): Promise<void> {
		try {
			await api(`/chat/rooms/${roomId}/members/${target}`, { method: 'DELETE' });
			if (target === me.id) {
				rooms = rooms.filter((r) => r.id !== roomId);
				if (roomId === openId) {
					membersOpen = false;
					openId = null;
					showRail = true;
				}
			} else {
				const room = rooms.find((r) => r.id === roomId);
				if (room) room.members = room.members.filter((m) => m.id !== target);
			}
		} catch (err) {
			toast('error', errMessage(err, 'could not remove member'));
		}
	}

	function canEdit(m: ChatMessage): boolean {
		return m.userId === me.id && m.deletedAt === null && Date.now() - m.at < EDIT_WINDOW_MS;
	}

	function canDelete(m: ChatMessage): boolean {
		return m.deletedAt === null && (m.userId === me.id || canModerate);
	}

	async function saveEdit(m: ChatMessage): Promise<void> {
		const body = editDraft.trim();
		if (!body) return;
		try {
			const r = await api<{ message: ChatMessage }>(`/chat/messages/${m.id}`, {
				method: 'PATCH',
				body: { body }
			});
			mergeMessages([r.message]);
			editId = null;
		} catch (err) {
			toast('error', errMessage(err, 'edit failed'));
		}
	}

	async function confirmDelete(): Promise<void> {
		if (!deleteTarget) return;
		try {
			const r = await api<{ message: ChatMessage }>(`/chat/messages/${deleteTarget.id}`, {
				method: 'DELETE'
			});
			mergeMessages([r.message]);
		} catch (err) {
			toast('error', errMessage(err, 'delete failed'));
		} finally {
			deleteTarget = null;
			deleteOpen = false;
		}
	}

	function isImage(a: ChatAttachment): boolean {
		return a.mime.startsWith('image/');
	}

	function loadThumb(id: string): void {
		if (thumbs.has(id)) return;
		thumbs.set(id, { state: 'loading' });
		void fetch(adminHref(`/api/chat/attachments/${id}`))
			.then(async (res) => {
				if (!res.ok) throw new Error(`attachment ${res.status}`);
				thumbs.set(id, { state: 'ok', url: URL.createObjectURL(await res.blob()) });
			})
			.catch(() => thumbs.set(id, { state: 'err' }));
	}

	function downloadAttachment(a: ChatAttachment): void {
		const el = document.createElement('a');
		el.href = adminHref(`/api/chat/attachments/${a.id}`);
		el.download = a.name;
		el.click();
	}

	async function copyBody(body: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(body);
			toast('success', 'Copied to clipboard');
		} catch {
			// clipboard is undefined on insecure origins
			toast('error', 'could not copy');
		}
	}

	function openMenu(e: MouseEvent, items: CtxItem[]): void {
		if (items.length === 0) return;
		e.preventDefault();
		menu = { x: e.clientX, y: e.clientY, items };
	}

	function messageMenu(e: MouseEvent, m: ChatMessage): void {
		const items: CtxItem[] = [];
		if (m.deletedAt !== null || editId === m.id) return;
		if (m.body) {
			items.push({ label: 'Copy text', icon: Copy, action: () => copyBody(m.body) });
		}
		for (const a of m.attachments) {
			items.push({
				label: m.attachments.length === 1 ? 'Download attachment' : `Download ${a.name}`,
				icon: Download,
				action: () => {
					downloadAttachment(a);
				}
			});
		}
		if (canEdit(m)) {
			items.push({
				label: 'Edit',
				icon: Pencil,
				action: () => {
					editId = m.id;
					editDraft = m.body;
				}
			});
		}
		if (canDelete(m)) {
			items.push({
				label: 'Delete',
				icon: Trash,
				danger: true,
				action: () => {
					deleteTarget = m;
					deleteOpen = true;
				}
			});
		}
		openMenu(e, items);
	}

	function roomMenu(e: MouseEvent, room: ChatRoom): void {
		const items: CtxItem[] = [
			{
				label: 'Open',
				icon: MessageSquare,
				disabled: room.id === openId,
				action: () => open(room.id)
			},
			{
				label: 'Mark read',
				icon: CheckCheck,
				disabled: !room.preview || room.unread === 0,
				action: () => markReadRoom(room)
			}
		];
		if (room.kind === 'room') {
			items.push({
				label: 'Leave room',
				icon: LogOut,
				danger: true,
				action: () => {
					leaveTargetId = room.id;
					leaveOpen = true;
				}
			});
		}
		openMenu(e, items);
	}

	function onWinKey(e: KeyboardEvent): void {
		if (e.key === 'Escape' && lightbox) {
			e.preventDefault();
			lightbox = null;
		}
	}

	interface DisplayRow {
		day: string;
		items: { m: ChatMessage; first: boolean }[];
	}

	// A message starts a new visual group when the sender changes, the
	// gap exceeds five minutes, or the previous row was a tombstone.
	function groupStart(prev: ChatMessage | null, m: ChatMessage): boolean {
		if (!prev) return true;
		return prev.userId !== m.userId || m.at - prev.at > GROUP_MS || prev.deletedAt !== null;
	}

	const rows = $derived.by((): DisplayRow[] => {
		const out: DisplayRow[] = [];
		let prev: ChatMessage | null = null;
		for (const m of messages) {
			const day = new Date(m.at).toDateString();
			let cur = out.at(-1);
			if (cur === undefined) {
				cur = { day, items: [] };
				out.push(cur);
			} else if (cur.day !== day) {
				cur = { day, items: [] };
				out.push(cur);
				prev = null;
			}
			cur.items.push({ m, first: groupStart(prev, m) });
			prev = m;
		}
		return out;
	});

	function fmtDay(day: string): string {
		const d = new Date(day);
		const today = new Date().toDateString();
		const yesterday = new Date(Date.now() - 86_400_000).toDateString();
		if (day === today) return 'Today';
		if (day === yesterday) return 'Yesterday';
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function fmtTime(at: number): string {
		return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	}

	// Deep link from search/palette: /chat?room=<id>. Tracked so it also
	// fires when the query changes while already on this page.
	let appliedRoomParam = '';
	$effect(() => {
		const want = page.url.searchParams.get('room') ?? '';
		if (want && want !== appliedRoomParam && rooms.some((r) => r.id === want)) {
			appliedRoomParam = want;
			void open(want);
		}
	});

	// Kick off thumbnail fetches for image attachments in view.
	$effect(() => {
		for (const m of messages) {
			for (const a of m.attachments) {
				if (isImage(a)) loadThumb(a.id);
			}
		}
	});

	// Object URLs belong to the open room. The cleanup runs before the
	// effect re-runs and on destroy, so thumbs and staged blobs are
	// released on every room switch and on unmount.
	$effect(() => {
		if (openId === null) return;
		return () => {
			revokeThumbs();
			clearPending();
		};
	});

	onMount(() => {
		void loadRooms();
		void loadPeers();
		connect();
		clockTimer = setInterval(() => (now = Date.now()), 30_000);
		pollTimer = setInterval(() => {
			if (!wsLive) {
				void loadRooms();
				void pollMessages();
			}
			const now = Date.now();
			const alive = Object.entries(typing).filter(([, exp]) => exp > now);
			if (alive.length !== Object.keys(typing).length) {
				typing = Object.fromEntries(alive);
			}
		}, POLL_MS);
		return () => {
			destroyed = true;
			if (pollTimer) clearInterval(pollTimer);
			if (clockTimer) clearInterval(clockTimer);
			if (retryTimer) clearTimeout(retryTimer);
			ws?.close();
			revokeThumbs();
			clearPending();
		};
	});
</script>

<svelte:window onkeydown={onWinKey} />

<div
	class="-mx-4 -mb-16 flex h-[calc(100dvh-5rem)] overflow-hidden border-t border-edge md:-mx-8 md:h-[calc(100dvh-2rem)]"
>
	<!-- Conversation rail -->
	<aside class="w-72 shrink-0 flex-col border-r border-edge {showRail ? 'flex' : 'hidden'} md:flex">
		<div class="flex items-center gap-2 border-b border-edge px-3 py-3">
			<div class="relative flex-1">
				<input
					class="input py-1.5 pl-8 text-xs"
					placeholder="Search conversations"
					bind:value={filter}
					aria-label="Search conversations"
				/>
				<MessageSquare class="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
			</div>
			<button
				class="btn btn-sm shrink-0"
				title="New direct message"
				onclick={() => (newChatOpen = true)}
			>
				<UserPlus class="size-3.5" />
			</button>
			<button class="btn btn-sm shrink-0" title="New room" onclick={() => (newRoomOpen = true)}>
				<Hash class="size-3.5" />
			</button>
		</div>
		<div class="thin-scroll flex-1 overflow-y-auto">
			{#if loadingRooms}
				{#each [0, 1, 2, 3, 4, 5] as n (n)}
					<div class="flex items-center gap-3 px-3 py-3">
						<div class="size-8 animate-pulse rounded-full bg-panel"></div>
						<div class="flex-1 space-y-1.5">
							<div class="h-3 w-2/3 animate-pulse rounded bg-panel"></div>
							<div class="h-2.5 w-1/2 animate-pulse rounded bg-panel"></div>
						</div>
					</div>
				{/each}
			{:else if filteredRooms.length === 0}
				<div class="px-4 py-10 text-center">
					<MessageSquare class="mx-auto size-8 text-faint" />
					<p class="mt-3 text-sm text-muted">
						{rooms.length === 0 ? 'No conversations yet.' : 'No matches.'}
					</p>
					{#if rooms.length === 0}
						<button class="btn btn-sm mt-4" onclick={() => (newChatOpen = true)}>
							Start a chat
						</button>
					{/if}
				</div>
			{:else}
				{#each filteredRooms as room (room.id)}
					{@const title = roomTitle(room)}
					{@const shown = room.members.filter((m) => m.id !== me.id).slice(0, 4)}
					<button
						class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors {openId ===
						room.id
							? 'bg-panel'
							: 'hover:bg-panel/50'}"
						onclick={() => void open(room.id)}
						oncontextmenu={(e) => {
							roomMenu(e, room);
						}}
					>
						<span class="flex shrink-0 -space-x-2.5">
							{#if room.kind === 'dm'}
								{@const o = otherOf(room)}
								{#if o}
									<ChatAvatar
										userId={o.id}
										name={o.displayName || o.username}
										hasAvatar={o.hasAvatar}
										presence={presenceOf(o.id)}
										size="size-8"
									/>
								{/if}
							{:else}
								{#each shown.slice(0, 3) as m (m.id)}
									<ChatAvatar
										userId={m.id}
										name={m.displayName || m.username}
										hasAvatar={m.hasAvatar}
										presence={presenceOf(m.id)}
										size="size-8"
									/>
								{/each}
								{#if shown.length === 0}
									<ChatAvatar
										userId={me.id}
										name={me.displayName || me.username}
										hasAvatar={me.hasAvatar ?? false}
										size="size-8"
									/>
								{:else if room.members.length - 1 > 3}
									<span
										class="flex size-8 items-center justify-center rounded-full border border-edge bg-panel text-[10px] font-medium text-muted"
									>
										+{room.members.length - 1 - 3}
									</span>
								{/if}
							{/if}
						</span>
						<span class="min-w-0 flex-1">
							<span class="flex items-baseline justify-between gap-2">
								<span class="truncate text-sm font-medium text-fg">{title}</span>
								{#if room.preview}
									<span class="shrink-0 text-[10px] text-faint"
										>{relativeTime(room.preview.at, now)}</span
									>
								{/if}
							</span>
							<span class="mt-0.5 flex items-center justify-between gap-2">
								<span class="truncate text-xs text-faint">
									{#if room.preview}
										{#if room.preview.deleted}
											<i>message deleted</i>
										{:else}
											{room.preview.username === me.username ? 'you: ' : ''}{room.preview.body}
										{/if}
									{:else}
										No messages yet
									{/if}
								</span>
								{#if room.unread > 0}
									<span
										class="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-bg"
										>{room.unread > 99 ? '99+' : room.unread}</span
									>
								{/if}
							</span>
						</span>
					</button>
				{/each}
			{/if}
		</div>
	</aside>

	<!-- Conversation pane -->
	<section
		class="relative flex min-w-0 flex-1 flex-col {showRail ? 'hidden md:flex' : 'flex'}"
		aria-label="Conversation"
		ondragover={onDragOver}
		ondragleave={onDragLeave}
		ondrop={onDrop}
	>
		{#if openRoom}
			{@const others = openRoom.members.filter((m) => m.id !== me.id)}
			<header class="flex items-center gap-3 border-b border-edge px-3 py-2.5 md:px-4">
				<button
					class="btn btn-ghost btn-sm -ml-1 md:hidden"
					aria-label="Back to conversations"
					onclick={() => (showRail = true)}
				>
					<ArrowLeft class="size-4" />
				</button>
				<span class="flex -space-x-2">
					{#each others.slice(0, 4) as m (m.id)}
						<ChatAvatar
							userId={m.id}
							name={m.displayName || m.username}
							hasAvatar={m.hasAvatar}
							presence={presenceOf(m.id)}
							size="size-7"
						/>
					{/each}
					{#if others.length > 4}
						<span
							class="flex size-7 items-center justify-center rounded-full border border-edge bg-panel text-[10px] text-muted"
							>+{others.length - 4}</span
						>
					{/if}
				</span>
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-semibold text-fg">{roomTitle(openRoom)}</p>
					<p class="truncate text-xs text-faint">
						{#if typingNames.length > 0}
							{typingNames.join(', ')}
							{typingNames.length === 1 ? 'is' : 'are'} typing...
						{:else if onlineCount > 0}
							{onlineCount} online · {openRoom.members.length}
							{openRoom.members.length === 1 ? 'member' : 'members'}
						{:else}
							{openRoom.members.length}
							{openRoom.members.length === 1 ? 'member' : 'members'}
						{/if}
					</p>
				</div>
				{#if openRoom.kind === 'room'}
					<button
						class="btn btn-ghost btn-sm {membersOpen ? 'bg-panel text-fg' : ''}"
						title="Members"
						aria-pressed={membersOpen}
						onclick={() => (membersOpen = !membersOpen)}
					>
						<Users class="size-4" />
					</button>
				{/if}
			</header>

			<div bind:this={listEl} class="thin-scroll flex-1 overflow-y-auto px-3 py-3 md:px-4">
				{#if loadingMsgs}
					{#each [0, 1, 2, 3, 4] as i (i)}
						<div class="mb-4 flex {i % 2 === 0 ? '' : 'justify-end'}">
							<div class="space-y-1.5 {i % 2 === 0 ? '' : 'text-right'}">
								<div class="h-2.5 w-20 animate-pulse rounded bg-panel"></div>
								<div
									class="h-9 animate-pulse rounded-xl bg-panel {i % 3 === 0 ? 'w-56' : 'w-40'}"
								></div>
							</div>
						</div>
					{/each}
				{:else if messages.length === 0}
					<div class="flex h-full flex-col items-center justify-center text-center">
						<MessageSquare class="size-8 text-faint" />
						<p class="mt-3 text-sm text-muted">No messages yet.</p>
						<p class="mt-1 text-xs text-faint">
							Messages are encrypted at rest on this server, not end-to-end.
						</p>
					</div>
				{:else}
					{#if hasMore}
						<div class="mb-2 text-center">
							<button class="btn btn-ghost btn-sm" disabled={loadingOlder} onclick={loadOlder}>
								{loadingOlder ? 'Loading...' : 'Load older messages'}
							</button>
						</div>
					{/if}
					{#each rows as group (group.day)}
						<div class="my-3 flex items-center gap-3">
							<span class="h-px flex-1 bg-edge"></span>
							<span class="text-[10px] font-medium uppercase tracking-wide text-faint"
								>{fmtDay(group.day)}</span
							>
							<span class="h-px flex-1 bg-edge"></span>
						</div>
						{#each group.items as item (item.m.id)}
							{@const m = item.m}
							{@const own = m.userId === me.id}
							<div class="group flex {own ? 'justify-end' : ''} {item.first ? 'mt-3' : 'mt-0.5'}">
								{#if !own && item.first}
									<div class="mr-2 mt-0.5 w-7 shrink-0">
										<ChatAvatar
											userId={m.userId}
											name={m.displayName || m.username}
											hasAvatar={m.hasAvatar}
											presence={presenceOf(m.userId)}
											size="size-7"
										/>
									</div>
								{:else if !own}
									<div class="mr-2 w-7 shrink-0"></div>
								{/if}
								<div class="max-w-[75%] min-w-0">
									{#if item.first}
										<p class="mb-0.5 text-xs text-faint {own ? 'text-right' : ''}">
											{#if !own}{m.displayName || m.username} ·
											{/if}{fmtTime(m.at)}
										</p>
									{/if}
									{#if m.deletedAt !== null}
										<p
											class="rounded-xl px-3 py-1.5 text-xs italic text-faint {own
												? 'bg-panel/60'
												: 'bg-panel/40'}"
										>
											message deleted
										</p>
									{:else if editId === m.id}
										<div class="flex items-end gap-1.5">
											<textarea
												class="input w-64 resize-none"
												rows="2"
												maxlength={BODY_MAX}
												bind:value={editDraft}
												onkeydown={(e) => {
													if (e.key === 'Enter' && !e.shiftKey) {
														e.preventDefault();
														void saveEdit(m);
													}
													if (e.key === 'Escape') editId = null;
												}}></textarea>
											<button
												class="btn btn-ghost btn-sm"
												aria-label="Save edit"
												onclick={() => void saveEdit(m)}><Check class="size-3.5" /></button
											>
											<button
												class="btn btn-ghost btn-sm"
												aria-label="Cancel edit"
												onclick={() => (editId = null)}><X class="size-3.5" /></button
											>
										</div>
									{:else}
										<div class="flex items-end gap-1 {own ? 'flex-row-reverse' : ''}">
											<div
												class="rounded-2xl px-3 py-1.5 text-sm leading-relaxed {own
													? 'bg-accent/15 text-fg'
													: 'bg-panel text-fg'}"
												role="article"
												oncontextmenu={(e) => {
													messageMenu(e, m);
												}}
											>
												{#if m.body}<p class="whitespace-pre-wrap break-words">{m.body}</p>{/if}
												{#if m.attachments.length > 0}
													{@const imgs = m.attachments.filter(
														(a) => isImage(a) && thumbs.get(a.id)?.state !== 'err'
													)}
													{@const files = m.attachments.filter(
														(a) => !isImage(a) || thumbs.get(a.id)?.state === 'err'
													)}
													{#if imgs.length > 0}
														<div
															class="{m.body ? 'mt-1.5' : ''} grid gap-1.5 {imgs.length === 1
																? 'max-w-[280px]'
																: 'grid-cols-2'}"
														>
															{#each imgs as a (a.id)}
																{@const t = thumbs.get(a.id)}
																{#if t?.state === 'ok'}
																	<button
																		type="button"
																		class="cursor-zoom-in overflow-hidden rounded-lg border border-edge"
																		aria-label="Preview {a.name}"
																		onclick={() =>
																			(lightbox = { url: t.url, name: a.name, size: a.size })}
																	>
																		<img
																			src={t.url}
																			alt={a.name}
																			loading="lazy"
																			class="{imgs.length === 1
																				? 'max-h-64'
																				: 'h-28'} w-full object-cover"
																		/>
																	</button>
																{:else}
																	<div
																		class="{imgs.length === 1
																			? 'h-40'
																			: 'h-28'} animate-pulse rounded-lg bg-panel"
																	></div>
																{/if}
															{/each}
														</div>
													{/if}
													{#if files.length > 0}
														<div class="{m.body || imgs.length > 0 ? 'mt-1.5' : ''} space-y-1">
															{#each files as a (a.id)}
																<!-- eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- render tags on locally declared snippets type as void -->
																{@render fileChip(a)}
															{/each}
														</div>
													{/if}
												{/if}
												{#if m.editedAt !== null}
													<span class="mt-0.5 block text-[10px] text-faint"
														>edited {fmtTime(m.editedAt)}</span
													>
												{/if}
											</div>
											{#if canEdit(m) || canDelete(m)}
												<div
													class="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
												>
													{#if canEdit(m)}
														<button
															class="btn btn-ghost btn-sm px-1.5"
															aria-label="Edit message"
															onclick={() => {
																editId = m.id;
																editDraft = m.body;
															}}><Pencil class="size-3" /></button
														>
													{/if}
													{#if canDelete(m)}
														<button
															class="btn btn-ghost btn-sm px-1.5 text-down-fg"
															aria-label="Delete message"
															onclick={() => {
																deleteTarget = m;
																deleteOpen = true;
															}}><Trash class="size-3" /></button
														>
													{/if}
												</div>
											{/if}
										</div>
									{/if}
								</div>
							</div>
						{/each}
					{/each}
				{/if}
			</div>

			<footer class="border-t border-edge px-3 py-2.5 md:px-4">
				{#if pendingFiles.length > 0}
					<div class="mb-2 flex flex-wrap gap-1.5">
						{#each pendingFiles as f (f.id)}
							{@const blob = pendingBlobs.get(f.id)}
							{#if blob}
								<span class="relative">
									<img
										src={blob}
										alt={f.name}
										class="size-14 rounded-lg border border-edge object-cover"
									/>
									<button
										type="button"
										class="absolute -right-1.5 -top-1.5 rounded-full border border-edge bg-raised p-0.5 text-faint transition-colors hover:text-fg"
										aria-label="Remove attachment"
										onclick={() => {
											removePending(f.id);
										}}
									>
										<X class="size-3" />
									</button>
								</span>
							{:else}
								<span class="chip">
									{f.name}
									<span class="text-faint">{fmtBytes(f.size)}</span>
									<button
										class="-mr-1 rounded-full p-0.5 text-faint hover:text-fg"
										aria-label="Remove attachment"
										onclick={() => {
											removePending(f.id);
										}}
									>
										<X class="size-3" />
									</button>
								</span>
							{/if}
						{/each}
					</div>
				{/if}
				<div class="flex items-end gap-2">
					<button
						class="btn btn-ghost shrink-0 !px-2"
						aria-label="Attach files"
						title="Attach files"
						disabled={uploading}
						onclick={() => fileInputEl?.click()}
					>
						{#if uploading}<LoaderCircle class="size-4 animate-spin" />{:else}<Paperclip
								class="size-4"
							/>{/if}
					</button>
					<textarea
						bind:this={composerEl}
						class="input field-sizing-content max-h-36 flex-1 resize-none"
						rows="1"
						maxlength={BODY_MAX}
						placeholder="Message {roomTitle(openRoom)}"
						aria-label="Message"
						bind:value={draft}
						onkeydown={onComposerKey}
						oninput={onComposerInput}
						onpaste={onComposerPaste}></textarea>
					{#if draft.length > BODY_MAX - 500}
						<span
							class="shrink-0 self-center text-[10px] {draft.length >= BODY_MAX
								? 'text-down-fg'
								: 'text-faint'}">{draft.length}/{BODY_MAX}</span
						>
					{/if}
					<button
						class="btn btn-primary shrink-0"
						disabled={(!draft.trim() && pendingFiles.length === 0) || sending || uploading}
						aria-label="Send"
						onclick={() => void send()}
					>
						<Send class="size-4" />
					</button>
				</div>
				<input
					bind:this={fileInputEl}
					type="file"
					class="hidden"
					multiple
					onchange={(e) => void uploadFiles(e.currentTarget.files)}
				/>
			</footer>
			{#if dragOver}
				<div
					class="pointer-events-none absolute inset-0 z-10 flex items-end justify-center border-2 border-dashed border-accent/50 bg-accent/5 p-6"
				>
					<span class="rounded-lg border border-edge bg-raised px-3 py-1.5 text-xs text-muted">
						Drop files to attach
					</span>
				</div>
			{/if}
		{:else}
			<div class="hidden h-full flex-col items-center justify-center text-center md:flex">
				<MessageSquare class="size-10 text-faint" />
				<p class="mt-4 text-sm font-medium text-muted">Pick a conversation</p>
				<p class="mt-1 max-w-xs text-xs text-faint">
					Internal chat for the ops team. Bodies are encrypted at rest on this server. It is not
					end-to-end encryption.
				</p>
				<div class="mt-5 flex gap-2">
					<button class="btn btn-sm" onclick={() => (newChatOpen = true)}>
						<UserPlus class="size-3.5" /> New DM
					</button>
					<button class="btn btn-sm" onclick={() => (newRoomOpen = true)}>
						<Hash class="size-3.5" /> New room
					</button>
				</div>
			</div>
		{/if}
	</section>

	<!-- Members sidebar -->
	{#if openRoom && membersOpen}
		<button
			class="fixed inset-0 z-40 bg-black/50 lg:hidden"
			aria-label="Close members"
			onclick={() => (membersOpen = false)}
		></button>
		<aside
			class="fixed inset-y-0 right-0 z-50 flex w-64 flex-col border-l border-edge bg-raised lg:static lg:z-auto"
			aria-label="Members"
		>
			<div class="flex items-center justify-between border-b border-edge px-3 py-2.5">
				<p class="text-xs font-semibold tracking-wide text-muted uppercase">
					Members · {openRoom.members.length}
				</p>
				<button
					class="btn btn-ghost btn-sm !p-1.5"
					aria-label="Close members"
					onclick={() => (membersOpen = false)}
				>
					<X class="size-4" />
				</button>
			</div>
			<div class="border-b border-edge px-3 py-2">
				<div class="relative">
					<input
						class="input py-1.5 pl-8 text-xs"
						placeholder="Search members"
						bind:value={memberFilter}
						aria-label="Search members"
					/>
					<Search class="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
				</div>
			</div>
			<ul class="thin-scroll flex-1 divide-y divide-edge overflow-y-auto">
				{#each visibleMembers as m (m.id)}
					<li class="flex items-center gap-3 px-3 py-2.5">
						<ChatAvatar
							userId={m.id}
							name={m.displayName || m.username}
							hasAvatar={m.hasAvatar}
							presence={presenceOf(m.id)}
							size="size-8"
						/>
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm text-fg">{m.displayName || m.username}</span>
							<span class="block truncate text-xs text-faint">
								{m.username}
								{#if m.id === openRoom.createdBy}· creator{/if}
								{#if m.id === me.id}· you{/if}
							</span>
						</span>
						<span class="text-xs capitalize text-faint">{presenceOf(m.id)}</span>
						{#if m.id === me.id}
							<button
								class="btn btn-ghost btn-sm text-down-fg"
								onclick={() => {
									leaveTargetId = null;
									leaveOpen = true;
								}}>Leave</button
							>
						{:else if openRoom.createdBy === me.id || canModerate}
							<button
								class="btn btn-ghost btn-sm text-down-fg"
								onclick={() => void removeMember(openRoom.id, m.id)}>Remove</button
							>
						{/if}
					</li>
				{:else}
					<li class="px-3 py-6 text-center text-xs text-faint">No members match.</li>
				{/each}
			</ul>
			{#if memberCandidates.length > 0}
				<div class="flex items-center gap-2 border-t border-edge p-3">
					<select class="input flex-1 text-xs" bind:value={addPick} aria-label="Add member">
						<option value={0}>Add member...</option>
						{#each memberCandidates as p (p.id)}
							<option value={p.id}>{p.displayName || p.username}</option>
						{/each}
					</select>
					<button class="btn btn-sm" disabled={!addPick} onclick={() => void addMember()}
						>Add</button
					>
				</div>
			{/if}
		</aside>
	{/if}
</div>

<!-- New DM modal -->
<Modal bind:open={newChatOpen} title="New direct message">
	{#if peers.length === 0}
		<p class="text-sm text-faint">No other enabled users.</p>
	{:else}
		<ul class="divide-y divide-edge">
			{#each peers as p (p.id)}
				<li>
					<button
						class="flex w-full items-center gap-3 px-1 py-2.5 text-left transition-colors hover:bg-panel/40"
						onclick={() => void startDm(p.id)}
					>
						<ChatAvatar
							userId={p.id}
							name={p.displayName || p.username}
							hasAvatar={p.hasAvatar}
							presence={presenceOf(p.id)}
							size="size-8"
						/>
						<span class="min-w-0">
							<span class="block truncate text-sm text-fg">{p.displayName || p.username}</span>
							{#if p.displayName}
								<span class="block truncate text-xs text-faint">{p.username}</span>
							{/if}
						</span>
						<span class="ml-auto text-xs capitalize text-faint">{presenceOf(p.id)}</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</Modal>

<!-- New room modal -->
<Modal bind:open={newRoomOpen} title="New room">
	<div class="space-y-4">
		<Field label="Room name" required>
			<input class="input" bind:value={roomName} maxlength={80} placeholder="ops-war-room" />
		</Field>
		<Field label="Members" hint="Optional. You are added automatically, others can join later.">
			<div class="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-edge p-2">
				{#each peers as p (p.id)}
					{@const on = roomPicks.includes(p.id)}
					<button
						type="button"
						class="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors {on
							? 'bg-accent/10'
							: 'hover:bg-panel/50'}"
						aria-pressed={on}
						onclick={() => {
							roomPicks = on ? roomPicks.filter((x) => x !== p.id) : [...roomPicks, p.id];
						}}
					>
						<ChatAvatar
							userId={p.id}
							name={p.displayName || p.username}
							hasAvatar={p.hasAvatar}
							size="size-6"
						/>
						<span class="truncate text-sm text-fg">{p.displayName || p.username}</span>
						<span class="ml-auto text-xs text-faint">{p.username}</span>
						<span
							class="flex size-4.5 shrink-0 items-center justify-center rounded-full border transition-colors {on
								? 'border-accent bg-accent text-bg'
								: 'border-edge text-transparent'}"
						>
							<Check class="size-3" />
						</span>
					</button>
				{:else}
					<p class="px-2 py-3 text-xs text-faint">No other enabled users.</p>
				{/each}
			</div>
		</Field>
		<div class="flex justify-end gap-2">
			<button class="btn" onclick={() => (newRoomOpen = false)}>Cancel</button>
			<button
				class="btn btn-primary"
				disabled={!roomName.trim() || busy}
				onclick={() => void createRoom()}
			>
				Create room
			</button>
		</div>
	</div>
</Modal>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Delete message?"
	description="The message is replaced by a tombstone for everyone."
	confirmLabel="Delete"
	danger
	onconfirm={() => void confirmDelete()}
/>

<ConfirmDialog
	bind:open={leaveOpen}
	title="Leave room?"
	description="You will stop receiving messages from this room."
	confirmLabel="Leave"
	danger
	onconfirm={() => {
		leaveOpen = false;
		const roomId = leaveTargetId ?? openId;
		leaveTargetId = null;
		if (roomId) void removeMember(roomId, me.id);
	}}
/>

{#snippet fileChip(a: ChatAttachment)}
	<a
		href={adminHref(`/api/chat/attachments/${a.id}`)}
		class="flex items-center gap-2 rounded-lg border border-edge bg-bg/40 px-2 py-1.5 text-xs transition-colors hover:border-accent/40"
		download
	>
		{#if isImage(a)}
			<ImageIcon class="size-3.5 shrink-0 text-faint" />
		{:else}
			<FileText class="size-3.5 shrink-0 text-faint" />
		{/if}
		<span class="min-w-0 flex-1 truncate">{a.name}</span>
		<span class="shrink-0 text-faint">{fmtBytes(a.size)}</span>
	</a>
{/snippet}

{#if menu}
	{#key menu}
		<ContextMenu x={menu.x} y={menu.y} items={menu.items} onclose={() => (menu = null)} />
	{/key}
{/if}

{#if lightbox}
	<div
		class="animate-fade-in fixed inset-0 z-[90] flex items-center justify-center"
		role="dialog"
		aria-modal="true"
		aria-label="Image preview"
	>
		<button
			type="button"
			class="absolute inset-0 cursor-zoom-out bg-black/80"
			aria-label="Close preview"
			onclick={() => (lightbox = null)}
		></button>
		<figure
			class="pointer-events-none relative z-10 flex max-h-full max-w-5xl flex-col items-center gap-3"
		>
			<img
				src={lightbox.url}
				alt={lightbox.name}
				class="max-h-[82vh] max-w-full rounded-lg object-contain shadow-2xl"
			/>
			<figcaption class="text-xs text-faint">
				{lightbox.name} · {fmtBytes(lightbox.size)}
			</figcaption>
		</figure>
	</div>
{/if}
