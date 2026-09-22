import { blockedHost, type Egress, type FetchInit } from '../http/egress';

// Sentry-Relay-style upstream forwarder for telemetry relay mode.
// Envelopes are accepted into a bounded in-memory buffer and pumped
// upstream in order; the route answers the client as soon as the
// envelope is buffered (store-and-forward ingest semantics). 4xx and
// egress-blocked sends drop immediately, 5xx/429/network failures
// retry with exponential backoff up to retry_attempts, then drop.
// The buffer is deliberately memory-only: relay mode is the
// stateless edge role and must not write locally.

export interface Upstream {
	endpoint: string;
	publicKey: string;
}

/**
 * Parse a Sentry dsn into its envelope endpoint and public key. Same
 * shape as the outbound reporter's parser in lib/server/telemetry.ts:
 * the last path segment is the project id, earlier segments are a
 * mount prefix.
 */
export function parseUpstreamDsn(dsn: string): Upstream | null {
	try {
		const u = new URL(dsn);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
		const segs = u.pathname.replace(/\/+$/g, '').split('/').filter(Boolean);
		const projectId = segs.at(-1) ?? '';
		if (!u.username || !projectId || !/^\w+$/.test(projectId)) return null;
		const prefix = segs.slice(0, -1).join('/');
		return {
			endpoint: `${u.origin}${prefix ? `/${prefix}` : ''}/api/${projectId}/envelope/`,
			publicKey: u.username
		};
	} catch {
		return null;
	}
}

export interface RelayTuning {
	timeoutMs: number;
	retryBaseMs: number;
	retryMaxMs: number;
	retryAttempts: number;
	maxPending: number;
}

interface Pending {
	upstream: Upstream;
	body: Uint8Array;
	attempts: number;
	nextAt: number;
}

export interface RelayStats {
	forwarded: number;
	dropped: number;
	upstreamFailures: number;
	retries: number;
	pending: number;
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		// Unref so a pending backoff never keeps the process alive.
		const t = setTimeout(resolve, ms);
		t.unref();
	});

export class RelayForwarder {
	private pending: Pending[] = [];
	private pumpPromise: Promise<void> | null = null;
	private readonly counters = {
		forwarded: 0,
		dropped: 0,
		upstreamFailures: 0,
		retries: 0
	};

	// fetchFn and sleep are injectable so tests stay deterministic and
	// never touch the network.
	constructor(
		private readonly egress: Egress,
		private readonly tuning: () => RelayTuning,
		private readonly fetchFn: typeof fetch = fetch,
		private readonly sleep: (ms: number) => Promise<void> = defaultSleep
	) {}

	stats(): RelayStats {
		return { ...this.counters, pending: this.pending.length };
	}

	/** Buffer one envelope for upstream delivery. False when full. */
	enqueue(upstream: Upstream, body: Uint8Array): boolean {
		if (this.pending.length >= this.tuning().maxPending) return false;
		this.pending.push({ upstream, body, attempts: 0, nextAt: 0 });
		this.kick();
		return true;
	}

	private kick(): void {
		this.pumpPromise ??= this.pump().finally(() => {
			this.pumpPromise = null;
		});
	}

	/** Resolves when the current pump run empties the buffer. */
	idle(): Promise<void> {
		return this.pumpPromise ?? Promise.resolve();
	}

	private async pump(): Promise<void> {
		while (this.pending.length > 0) {
			const head = this.pending[0];
			const t = this.tuning();
			const now = Date.now();
			if (head.nextAt > now) {
				await this.sleep(head.nextAt - now);
				continue;
			}
			const res = await this.send(head, t.timeoutMs);
			if (res === 'ok') {
				this.pending.shift();
				this.counters.forwarded++;
				continue;
			}
			if (res === 'drop') {
				this.pending.shift();
				this.counters.dropped++;
				continue;
			}
			head.attempts++;
			this.counters.upstreamFailures++;
			if (head.attempts > t.retryAttempts) {
				this.pending.shift();
				this.counters.dropped++;
				continue;
			}
			this.counters.retries++;
			head.nextAt = Date.now() + Math.min(t.retryBaseMs * 2 ** (head.attempts - 1), t.retryMaxMs);
		}
	}

	private async send(entry: Pending, timeoutMs: number): Promise<'ok' | 'drop' | 'retry'> {
		const host = new URL(entry.upstream.endpoint).hostname;
		if (!this.egress.allowLinkLocal() && blockedHost(host)) return 'drop';
		try {
			const res = await this.fetchFn(entry.upstream.endpoint, {
				method: 'POST',
				headers: {
					'content-type': 'application/x-sentry-envelope',
					'x-sentry-auth': [
						'Sentry sentry_version=7',
						'sentry_client=wharfinger-relay',
						`sentry_timestamp=${Math.floor(Date.now() / 1000)}`,
						`sentry_key=${entry.upstream.publicKey}`
					].join(', ')
				},
				body: entry.body,
				signal: AbortSignal.timeout(timeoutMs),
				redirect: 'manual',
				dispatcher: this.egress.dispatcher
			} as FetchInit);
			// Drain so the connection can be reused.
			await res.arrayBuffer().catch(() => undefined);
			if (res.status >= 200 && res.status < 300) return 'ok';
			// 429 is upstream backpressure; other 4xx mean the upstream
			// refused the envelope itself.
			if (res.status >= 400 && res.status < 500 && res.status !== 429) return 'drop';
			return 'retry';
		} catch {
			return 'retry';
		}
	}
}
