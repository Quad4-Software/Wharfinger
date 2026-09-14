import { browser } from '$app/environment';
import { paths } from '$lib/shared/paths';
import type { StatusSnapshot } from '$lib/shared/types';

// Live status feed. Strategy: SSE for instant pushes, with a slow ETag
// poll as a safety net for proxies that kill long-lived connections.
// Everything funnels into onSnapshot so the UI only ever renders one
// consistent data path.
export class StatusStream {
	live = $state(false);
	lastSyncAt = $state(Date.now());

	private es: EventSource | null = null;
	private etag = '';
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private stopped = false;

	constructor(
		private readonly onSnapshot: (s: StatusSnapshot) => void,
		private readonly refreshSeconds: number
	) {}

	start(): void {
		if (!browser || this.stopped) return;
		this.stopped = false;
		if (typeof EventSource !== 'undefined') {
			this.connect();
		}
		this.startPolling();
	}

	stop(): void {
		this.stopped = true;
		this.es?.close();
		this.es = null;
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = null;
		this.live = false;
	}

	private connect(): void {
		const es = new EventSource(paths.apiStream);
		this.es = es;
		es.addEventListener('snapshot', (e: MessageEvent<string>) => {
			this.live = true;
			try {
				this.onSnapshot(JSON.parse(e.data) as StatusSnapshot);
				this.lastSyncAt = Date.now();
			} catch {
				// Malformed payload; next event or poll will recover.
			}
		});
		es.addEventListener('ping', () => {
			this.live = true;
			this.lastSyncAt = Date.now();
		});
		es.onerror = () => {
			this.live = false;
			// EventSource retries automatically; the poll below covers the gap.
		};
	}

	private startPolling(): void {
		const interval = Math.max(this.refreshSeconds, 15) * 1000;
		this.pollTimer = setInterval(() => {
			if (document.visibilityState !== 'visible') return;
			void this.poll();
		}, interval);
	}

	private async poll(): Promise<void> {
		try {
			const res = await fetch(paths.apiStatus, {
				headers: this.etag ? { 'if-none-match': this.etag } : {}
			});
			if (res.status === 304) {
				this.lastSyncAt = Date.now();
				return;
			}
			if (!res.ok) return;
			const etag = res.headers.get('etag');
			if (etag) this.etag = etag;
			this.onSnapshot((await res.json()) as StatusSnapshot);
			this.lastSyncAt = Date.now();
		} catch {
			// Offline; keep the last snapshot on screen.
		}
	}
}
