import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { StatusConfig } from '../config/schema';
import type { Egress } from '../http/egress';
import { dataDir } from '../store/db';
import type { MarkerStore } from '../store/markers';
import {
	itemFromEnvelope,
	normalizeEvent,
	normalizeTransaction,
	type EnvelopeItem
} from './ingest';
import { parseUpstreamDsn, RelayForwarder, type RelayTuning } from './relay';
import { EnvelopeSpool, type SpoolEntry, type SpoolVerdict } from './spool';
import type { TelemetryStore } from './store';

// Ingest pipeline for the Sentry-compatible endpoints. Mode comes
// from [telemetry.ingest]:
//   local  write straight to the store (default, unchanged path)
//   relay  scrub and forward to upstream_dsn, no local event writes
//   queue  spool to <data>/telemetry-spool/, flush in the background
// Per-project and per-ip token buckets run before parsing, and a
// small LRU collapses duplicate event_ids before any store write.
// The singletons below live on the module so config reloads change
// behavior without a restart; state that must survive restarts is in
// the spool, not here.

export type IngestConfig = StatusConfig['telemetry']['ingest'];

// Narrow structural view of Runtime so tests can fake the pieces the
// pipeline needs without booting the composition root.
export interface IngestDeps {
	config: Pick<StatusConfig, 'telemetry'>;
	egress: Egress;
	telemetry: Pick<TelemetryStore, 'project' | 'record' | 'recordTrace'>;
	markers: Pick<MarkerStore, 'exists' | 'add'>;
}

/** Token bucket with continuous refill; perMinute <= 0 disables it. */
export class TokenBucket {
	private buckets = new Map<string, { tokens: number; ts: number }>();
	private swept = 0;

	allow(key: string, perMinute: number, now = Date.now()): boolean {
		if (perMinute <= 0) return true;
		if (now - this.swept > 60_000) this.sweep(now);
		let b = this.buckets.get(key);
		if (b === undefined) {
			b = { tokens: perMinute, ts: now };
			this.buckets.set(key, b);
		}
		b.tokens = Math.min(perMinute, b.tokens + ((now - b.ts) * perMinute) / 60_000);
		b.ts = now;
		if (b.tokens < 1) return false;
		b.tokens -= 1;
		return true;
	}

	private sweep(now: number): void {
		this.swept = now;
		// A bucket refills fully after one idle window; anything older
		// only costs memory.
		for (const [k, b] of this.buckets) {
			if (now - b.ts > 120_000) this.buckets.delete(k);
		}
	}
}

/** Small LRU over event ids so retried submissions do not double-store. */
export class EventDedupe {
	private seen = new Map<string, number>();

	constructor(
		private readonly ttlMs = 15 * 60_000,
		private readonly cap = 10_000
	) {}

	/** True when the key was already seen inside the TTL window. */
	isDup(key: string, now = Date.now()): boolean {
		const last = this.seen.get(key);
		if (last !== undefined && now - last < this.ttlMs) return true;
		this.seen.delete(key);
		this.seen.set(key, now);
		if (this.seen.size > this.cap) {
			// Map iterates in insert order; drop the oldest half.
			let n = Math.floor(this.cap / 2);
			for (const k of this.seen.keys()) {
				if (n-- <= 0) break;
				this.seen.delete(k);
			}
		}
		return false;
	}

	get size(): number {
		return this.seen.size;
	}
}

const ipBucket = new TokenBucket();
const projectBucket = new TokenBucket();
const dedupe = new EventDedupe();
const counters = {
	stored: 0,
	deduped: 0,
	rateLimited: 0,
	queued: 0,
	queueRejected: 0,
	dropped: 0
};

let spool: EnvelopeSpool | null = null;
let forwarder: RelayForwarder | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Ingest counters, for health surfaces and tests. */
export function ingestStats(): Record<string, number> {
	return {
		...counters,
		spoolDepth: spool?.size ?? 0,
		relayPending: forwarder?.stats().pending ?? 0,
		forwarded: forwarder?.stats().forwarded ?? 0,
		upstreamFailures: forwarder?.stats().upstreamFailures ?? 0,
		upstreamRetries: forwarder?.stats().retries ?? 0,
		relayDropped: forwarder?.stats().dropped ?? 0
	};
}

/** Per-client-ip bucket; runs before project resolution. */
export function ingestIpAllowed(cfg: IngestConfig, ip: string, now = Date.now()): boolean {
	const ok = ipBucket.allow(`ip:${ip}`, cfg.rate_limit_per_minute, now);
	if (!ok) counters.rateLimited++;
	return ok;
}

/** Per-project bucket; runs once the DSN key resolved. */
export function ingestProjectAllowed(
	cfg: IngestConfig,
	projectId: number,
	now = Date.now()
): boolean {
	const ok = projectBucket.allow(`p:${projectId}`, cfg.rate_limit_per_minute, now);
	if (!ok) counters.rateLimited++;
	return ok;
}

/** True when this event_id was already accepted within the LRU window. */
export function ingestDup(projectId: number, eventId: string): boolean {
	const dup = dedupe.isDup(`${projectId}:${eventId}`);
	if (dup) counters.deduped++;
	return dup;
}

function itemEventId(item: EnvelopeItem): string | null {
	const raw = item.kind === 'event' ? item.event : item.transaction;
	const v = raw.event_id;
	return typeof v === 'string' ? v.slice(0, 64) : null;
}

// A new release string is a deploy: drop a chart marker the first
// time each value shows up so latency/uptime graphs get the line.
async function markRelease(rt: IngestDeps, release: string | null): Promise<void> {
	if (!release) return;
	const title = `release ${release}`.slice(0, 256);
	if (await rt.markers.exists(title, 0)) return;
	await rt.markers.add({ title, kind: 'release', source: 'telemetry' });
}

/**
 * Normalize one envelope item and persist it. Shared by the local
 * ingest path and the queue flush so both apply the same scrubbing,
 * dedupe, and release markers. 'dup' carries the id the client would
 * have received, so callers still answer 200.
 */
export async function persistItem(
	rt: IngestDeps,
	projectId: number,
	item: EnvelopeItem
): Promise<{ status: 'ok' | 'dup' | 'invalid'; id: string | null }> {
	if (item.kind === 'transaction') {
		const t = normalizeTransaction(item.transaction);
		if (!t) return { status: 'invalid', id: null };
		const evId = itemEventId(item);
		if (evId !== null && ingestDup(projectId, evId)) {
			return { status: 'dup', id: t.traceId };
		}
		await rt.telemetry.recordTrace({ projectId, ...t });
		await markRelease(rt, t.release);
		counters.stored++;
		return { status: 'ok', id: t.traceId };
	}
	const e = normalizeEvent(item.event);
	if (e.eventId !== null && ingestDup(projectId, e.eventId)) {
		return { status: 'dup', id: e.eventId };
	}
	await rt.telemetry.record({ projectId, ...e });
	await markRelease(rt, e.release);
	counters.stored++;
	return { status: 'ok', id: e.eventId };
}

function tuningOf(cfg: IngestConfig): RelayTuning {
	return {
		timeoutMs: cfg.upstream_timeout_ms,
		retryBaseMs: cfg.retry_base_ms,
		retryMaxMs: cfg.retry_max_ms,
		retryAttempts: cfg.retry_attempts,
		maxPending: cfg.max_queue
	};
}

function forwarderFor(rt: IngestDeps): RelayForwarder {
	// The tuning getter re-reads live config on every attempt so a
	// reload applies without rebuilding the buffer.
	forwarder ??= new RelayForwarder(rt.egress, () => tuningOf(rt.config.telemetry.ingest));
	return forwarder;
}

/**
 * Buffer a scrubbed envelope for upstream forwarding. 'full' means
 * the bounded retry buffer is saturated (the route answers 429) and
 * 'misconfigured' means relay mode has no usable upstream_dsn.
 */
export function relayEnqueue(
	rt: IngestDeps,
	cfg: IngestConfig,
	body: Uint8Array
): 'ok' | 'full' | 'misconfigured' {
	const upstream = parseUpstreamDsn(cfg.upstream_dsn);
	if (upstream === null) {
		counters.dropped++;
		return 'misconfigured';
	}
	if (!forwarderFor(rt).enqueue(upstream, body)) {
		counters.dropped++;
		return 'full';
	}
	return 'ok';
}

function spoolFor(): EnvelopeSpool {
	if (spool === null) {
		spool = new EnvelopeSpool(join(dataDir(), 'telemetry-spool'));
		spool.init();
	}
	return spool;
}

/**
 * Append an envelope to the durable spool. 'full' maps to a 429 in
 * the route so clients see backpressure instead of silent loss.
 */
export function spoolEnqueue(
	cfg: IngestConfig,
	projectId: number,
	eventId: string | null,
	body: Uint8Array
): 'ok' | 'full' {
	if (spoolFor().enqueue(projectId, eventId, body, cfg.max_queue) === 'full') {
		counters.queueRejected++;
		return 'full';
	}
	counters.queued++;
	return 'ok';
}

/** Flush sink: one spooled envelope into the local store. */
export async function spoolSink(rt: IngestDeps, entry: SpoolEntry): Promise<SpoolVerdict> {
	const project = await rt.telemetry.project(entry.projectId);
	// Deleted and disabled projects consume their backlog as drops.
	if (project === null) return 'drop';
	if (project.disabledAt !== null) return 'drop';
	const item = itemFromEnvelope(entry.body);
	if (item === null) return 'drop';
	try {
		const r = await persistItem(rt, project.id, item);
		return r.status === 'invalid' ? 'drop' : 'ok';
	} catch {
		// Store outage: keep the file and retry on the next tick.
		return 'retry';
	}
}

// Envelopes drained per flush tick; bounded so a huge backlog cannot
// monopolize the event loop in one pass.
const DRAIN_BATCH = 200;

export async function flushOnce(rt: IngestDeps): Promise<number> {
	return spoolFor().drain(DRAIN_BATCH, (e) => spoolSink(rt, e));
}

function scheduleFlush(rt: IngestDeps): void {
	flushTimer = setTimeout(() => {
		flushOnce(rt)
			.catch((err: unknown) => {
				console.error('[telemetry] spool flush failed:', err);
			})
			.finally(() => {
				scheduleFlush(rt);
			});
	}, rt.config.telemetry.ingest.flush_interval_ms);
	flushTimer.unref();
}

/**
 * Start the background spool drain when needed: always in queue
 * mode, and in any mode when a previous run left files behind so a
 * mode switch does not strand buffered envelopes.
 */
export function maybeStartFlush(rt: IngestDeps): void {
	if (flushTimer !== null) return;
	const cfg = rt.config.telemetry.ingest;
	if (cfg.mode !== 'queue') {
		const dir = join(dataDir(), 'telemetry-spool');
		if (!existsSync(dir)) return;
		try {
			if (!readdirSync(dir).some((n) => n.endsWith('.envelope'))) return;
		} catch {
			return;
		}
	}
	spoolFor();
	scheduleFlush(rt);
}

/** Test hook: drop module singletons so cases start clean. */
export function resetIngestPipeline(): void {
	if (flushTimer !== null) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	spool = null;
	forwarder = null;
	for (const k of Object.keys(counters) as (keyof typeof counters)[]) counters[k] = 0;
}
