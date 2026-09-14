// Process-wide chat fan-out bus. The ws bridge (server/chat-ws.mjs,
// loaded directly by node) registers the real emitter and presence
// provider in production; the SvelteKit route bundle calls emitChat on
// the same process. The registry lives on globalThis because vite
// bundles this module into the handler while node loads the file
// itself - two module instances, one shared bus. In dev mode no bridge
// is registered and emitChat is a no-op.

const g = /** @type {any} */ (globalThis);
const bus = (g.__wharfingerChatBus ??= { emit: null, presence: null });

/**
 * Register the ws broadcaster. Receives
 * { type: 'message' | 'update', room: string, members: number[],
 *   message: object }.
 * @param {(e: any) => void} fn
 */
export function registerChatEmitter(fn) {
	bus.emit = fn;
}

/**
 * Register the socket-derived presence provider. Returns
 * { [userId]: 'online' | 'away' } for users with a live socket.
 * @param {() => Record<string, 'online' | 'away'>} fn
 */
export function registerChatPresence(fn) {
	bus.presence = fn;
}

/**
 * Fan out a stored chat event to connected member sockets. No-op when
 * no bridge is attached (dev mode, tests).
 * @param {{ type: string, room: string, members: number[], message: any }} event
 */
export function emitChat(event) {
	bus.emit?.(event);
}

/**
 * Socket-derived presence states, or null when no bridge is attached.
 * @returns {Record<string, 'online' | 'away'> | null}
 */
export function chatPresence() {
	return bus.presence ? bus.presence() : null;
}
