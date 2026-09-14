// Typed front-end for the process-wide chat bus in server/chat-bus.mjs
// (see that file for why the registry lives on globalThis). Routes use
// this $lib alias instead of a deep relative import.
import { emitChat as emit, chatPresence as presence } from '../../../../server/chat-bus.mjs';
import type { ChatMessage, ChatPresenceState } from '$lib/shared/chat';

export interface ChatBusEvent {
	/** 'message' for new sends, 'update' for edits and deletes. */
	type: 'message' | 'update';
	room: string;
	/** Member user ids the event should fan out to. */
	members: number[];
	message: ChatMessage;
}

export function emitChat(event: ChatBusEvent): void {
	emit(event);
}

export function chatPresence(): Record<string, Exclude<ChatPresenceState, 'offline'>> | null {
	return presence();
}
