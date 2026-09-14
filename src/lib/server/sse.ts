// Tiny pub/sub hub for server-sent events. The monitor publishes state
// changes; each connected browser gets the fresh snapshot JSON.

import { SSE_HEARTBEAT_MS, SSE_MAX_CLIENTS } from './constants';

export interface SseClient {
	send(event: string, data: string): void;
	close(): void;
}

export class SseHub {
	private clients = new Set<SseClient>();
	private heartbeat: NodeJS.Timeout | null = null;

	add(client: SseClient): boolean {
		if (this.clients.size >= SSE_MAX_CLIENTS) return false;
		this.clients.add(client);
		if (!this.heartbeat) {
			this.heartbeat = setInterval(() => {
				for (const c of this.clients) {
					try {
						c.send('ping', '{}');
					} catch {
						this.clients.delete(c);
					}
				}
			}, SSE_HEARTBEAT_MS);
			this.heartbeat.unref();
		}
		return true;
	}

	remove(client: SseClient): void {
		this.clients.delete(client);
		if (this.clients.size === 0 && this.heartbeat) {
			clearInterval(this.heartbeat);
			this.heartbeat = null;
		}
	}

	broadcast(event: string, data: string): void {
		for (const c of this.clients) {
			try {
				c.send(event, data);
			} catch {
				this.clients.delete(c);
			}
		}
	}

	get size(): number {
		return this.clients.size;
	}
}

export function encodeSse(event: string, data: string): string {
	const lines = data.split('\n').map((l) => `data: ${l}`);
	return `event: ${event}\n${lines.join('\n')}\n\n`;
}
