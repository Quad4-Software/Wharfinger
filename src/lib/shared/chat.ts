// Client-safe chat shapes shared by the REST routes, the ws bridge
// payloads, and the panel page. Message bodies are always plaintext
// here; sealing happens at the storage boundary only.

export interface ChatMember {
	id: number;
	username: string;
	displayName: string;
	hasAvatar: boolean;
}

export interface ChatPreview {
	id: number;
	body: string;
	at: number;
	username: string;
	deleted: boolean;
}

export interface ChatRoom {
	id: string;
	kind: 'room' | 'dm';
	name: string;
	createdBy: number;
	createdAt: number;
	members: ChatMember[];
	unread: number;
	preview: ChatPreview | null;
}

export interface ChatMessage {
	id: number;
	roomId: string;
	userId: number;
	username: string;
	displayName: string;
	hasAvatar: boolean;
	body: string;
	at: number;
	editedAt: number | null;
	deletedAt: number | null;
}

export type ChatPresenceState = 'online' | 'away' | 'offline';

export type ChatPresenceMap = Record<string, ChatPresenceState>;

export interface ChatPeer {
	id: number;
	username: string;
	displayName: string;
	hasAvatar: boolean;
}
