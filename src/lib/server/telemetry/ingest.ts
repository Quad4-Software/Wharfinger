import { createHash } from 'node:crypto';
import type { TelemetryProject } from './store';

// Sentry-protocol ingest: envelope + store endpoints, event
// normalization, scrubbing, and issue fingerprinting. Bounds are
// strict; a hostile DSN holder gets a bounded write surface only.

export const ENVELOPE_MAX_BYTES = 1024 * 1024;
export const EVENT_MAX_BYTES = 256 * 1024;
const RAW_MAX_BYTES = 128 * 1024;
const MAX_ITEMS = 20;

export interface ParsedEvent {
	eventId: string | null;
	ts: number;
	level: string;
	platform: string | null;
	message: string | null;
	excType: string | null;
	excValue: string | null;
	release: string | null;
	environment: string | null;
	tags: string;
	request: string | null;
	stack: string | null;
	raw: string;
	fingerprint: string;
	title: string;
	culprit: string | null;
}

/** Public key from X-Sentry-Auth, Authorization, or the query string. */
export function sentryKey(req: Request): string | null {
	const url = new URL(req.url);
	const q = url.searchParams.get('sentry_key');
	if (q) return q.slice(0, 64);
	const hdr = req.headers.get('x-sentry-auth') ?? req.headers.get('authorization') ?? '';
	const m = /sentry_key=([a-z0-9]+)/i.exec(hdr);
	if (m) return m[1].slice(0, 64);
	const bearer = /^bearer\s+([a-z0-9]{6,64})$/i.exec(hdr.trim());
	if (bearer) return bearer[1];
	return null;
}

/**
 * Split an envelope body into its header and typed items. Items are
 * delimited by a JSON header line with an optional byte length;
 * payloads are raw bytes (attachments can be binary).
 */
function parseEnvelope(
	body: Uint8Array
): { header: Record<string, unknown>; items: { type: string; payload: Uint8Array }[] } | null {
	const nl = body.indexOf(0x0a);
	if (nl <= 0) return null;
	let header: Record<string, unknown>;
	try {
		header = JSON.parse(new TextDecoder().decode(body.subarray(0, nl))) as Record<string, unknown>;
	} catch {
		return null;
	}
	const items: { type: string; payload: Uint8Array }[] = [];
	let pos = nl + 1;
	const dec = new TextDecoder();
	while (pos < body.length && items.length < MAX_ITEMS) {
		const eol = body.indexOf(0x0a, pos);
		const headEnd = eol === -1 ? body.length : eol;
		let itemHead: { type?: string; length?: number };
		try {
			itemHead = JSON.parse(dec.decode(body.subarray(pos, headEnd))) as {
				type?: string;
				length?: number;
			};
		} catch {
			break;
		}
		if (typeof itemHead.type !== 'string') break;
		const start = headEnd + 1;
		let end: number;
		if (typeof itemHead.length === 'number' && itemHead.length >= 0) {
			end = Math.min(start + itemHead.length, body.length);
		} else {
			const next = body.indexOf(0x0a, start);
			end = next === -1 ? body.length : next;
		}
		items.push({ type: itemHead.type, payload: body.subarray(start, end) });
		pos = end + 1;
	}
	return { header, items };
}

const SENSITIVE_KEY =
	/pass(word|wd)?|secret|token|api[-_]?key|cookie|authorization|session|credential|private/i;
const SENSITIVE_HEADERS = new Set([
	'authorization',
	'cookie',
	'set-cookie',
	'x-api-key',
	'proxy-authorization'
]);

/** Deep-scrub event JSON: denylisted keys and cookies never persist. */
function scrub(v: unknown, depth = 0): unknown {
	if (depth > 8 || v === null || v === undefined) return v;
	if (Array.isArray(v)) return v.slice(0, 100).map((x) => scrub(x, depth + 1));
	if (typeof v === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 200)) {
			if (SENSITIVE_KEY.test(k)) {
				out[k] = '[Filtered]';
				continue;
			}
			if (k === 'headers' && val && typeof val === 'object' && !Array.isArray(val)) {
				const h: Record<string, unknown> = {};
				for (const [hk, hv] of Object.entries(val as Record<string, unknown>).slice(0, 100)) {
					h[hk] = SENSITIVE_HEADERS.has(hk.toLowerCase()) ? '[Filtered]' : hv;
				}
				out[k] = h;
				continue;
			}
			out[k] = scrub(val, depth + 1);
		}
		return out;
	}
	if (typeof v === 'string') return v.length > 16_384 ? `${v.slice(0, 16_384)}…` : v;
	return v;
}

/** Strip query/fragment so reported URLs never carry secrets. */
function scrubUrl(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	try {
		const u = new URL(raw);
		return `${u.origin}${u.pathname}`.slice(0, 1024);
	} catch {
		return raw.split(/[?#]/)[0]?.slice(0, 1024) ?? null;
	}
}

interface Frame {
	filename?: string;
	function?: string;
	lineno?: number;
	in_app?: boolean;
}

function excOf(ev: Record<string, unknown>): {
	type: string | null;
	value: string | null;
	frames: Frame[];
} {
	const values = (ev.exception as { values?: unknown[] } | undefined)?.values;
	const first = Array.isArray(values)
		? (values[0] as Record<string, unknown> | undefined)
		: undefined;
	if (!first) return { type: null, value: null, frames: [] };
	const frames = ((first.stacktrace as { frames?: Frame[] } | undefined)?.frames ?? []).slice(-50);
	return {
		type: typeof first.type === 'string' ? first.type.slice(0, 256) : null,
		value: typeof first.value === 'string' ? first.value.slice(0, 2048) : null,
		frames
	};
}

function messageOf(ev: Record<string, unknown>): { display: string | null; group: string | null } {
	// Sentry's logentry: `message` is the template, `formatted` the
	// rendered text. Group on the template so differing params still
	// land in one issue.
	const le = ev.logentry as { formatted?: unknown; message?: unknown } | undefined;
	if (le && typeof le === 'object') {
		const display =
			typeof le.formatted === 'string'
				? le.formatted.slice(0, 2048)
				: typeof le.message === 'string'
					? le.message.slice(0, 2048)
					: null;
		const group = typeof le.message === 'string' ? le.message : display;
		return { display, group };
	}
	const m = ev.message;
	if (typeof m === 'string') return { display: m.slice(0, 2048), group: m };
	if (m && typeof m === 'object') {
		const f = (m as { formatted?: unknown }).formatted;
		if (typeof f === 'string') return { display: f.slice(0, 2048), group: f };
	}
	return { display: null, group: null };
}

/**
 * Issue grouping fingerprint: exception type plus the top in-app
 * frame (or the oldest frame when nothing is flagged). Message-only
 * events group on a bounded prefix of the message.
 */
function fingerprintOf(
	platform: string | null,
	excType: string | null,
	frames: Frame[],
	message: string | null
): string {
	let basis: string;
	if (excType) {
		const top = [...frames].reverse().find((f) => f.in_app) ?? frames.at(-1);
		basis = top ? `ex:${excType}:${top.filename ?? ''}:${top.function ?? ''}` : `ex:${excType}`;
	} else {
		basis = `msg:${(message ?? '').slice(0, 120)}`;
	}
	return createHash('sha256')
		.update(`${platform ?? ''}|${basis}`)
		.digest('hex')
		.slice(0, 32);
}

/**
 * Normalize one event JSON object into a bounded StoredEvent-shaped
 * record. Everything attacker-controlled is length-capped and
 * scrubbed before it can reach the db.
 */
export function normalizeEvent(raw: Record<string, unknown>): ParsedEvent {
	const clean = scrub(raw) as Record<string, unknown>;
	const exc = excOf(clean);
	const { display: message, group: msgGroup } = messageOf(clean);
	const platform = typeof clean.platform === 'string' ? clean.platform.slice(0, 64) : null;
	const level =
		typeof clean.level === 'string' &&
		['fatal', 'error', 'warning', 'info', 'debug'].includes(clean.level)
			? clean.level
			: 'error';
	const frames = exc.frames;
	const stack = frames.length ? JSON.stringify(frames.slice(0, 50)) : null;
	const reqObj = clean.request as Record<string, unknown> | undefined;
	const req =
		reqObj && typeof reqObj === 'object'
			? {
					url: scrubUrl(reqObj.url),
					method: typeof reqObj.method === 'string' ? reqObj.method.slice(0, 16) : null,
					headers: reqObj.headers ?? null
				}
			: null;
	// The stored raw copy must not keep the unscrubbed url/query either.
	if (reqObj && typeof reqObj === 'object') {
		reqObj.url = scrubUrl(reqObj.url);
		if (typeof reqObj.query_string === 'string') reqObj.query_string = '[Filtered]';
		if (typeof reqObj.fragment === 'string') reqObj.fragment = '[Filtered]';
	}
	const tags = clean.tags && typeof clean.tags === 'object' ? clean.tags : {};
	const now = Date.now();
	// Future timestamps poison last_seen ordering; allow 60s skew.
	const ts =
		typeof clean.timestamp === 'number' && clean.timestamp > 0
			? Math.min(Math.round(clean.timestamp * 1000), now + 60_000)
			: now;
	const title = exc.type
		? `${exc.type}: ${(exc.value ?? '').slice(0, 160)}`
		: (message ?? 'event').slice(0, 160);
	const culprit =
		typeof clean.culprit === 'string'
			? clean.culprit.slice(0, 256)
			: (([...frames].reverse().find((f) => f.in_app) ?? frames.at(-1))?.function?.slice(0, 256) ??
				null);
	return {
		eventId: typeof clean.event_id === 'string' ? clean.event_id.slice(0, 64) : null,
		ts,
		level,
		platform,
		message,
		excType: exc.type,
		excValue: exc.value,
		release: typeof clean.release === 'string' ? clean.release.slice(0, 256) : null,
		environment: typeof clean.environment === 'string' ? clean.environment.slice(0, 128) : null,
		tags: JSON.stringify(tags).slice(0, 8192),
		request: req ? JSON.stringify(req).slice(0, 8192) : null,
		stack,
		raw: JSON.stringify(clean).slice(0, RAW_MAX_BYTES),
		fingerprint: fingerprintOf(platform, exc.type, frames, msgGroup),
		title,
		culprit
	};
}

export type EnvelopeItem =
	| { kind: 'event'; event: Record<string, unknown> }
	| { kind: 'transaction'; transaction: Record<string, unknown> };

/** Pull the first event or transaction item out of a parsed envelope. */
export function itemFromEnvelope(body: Uint8Array): EnvelopeItem | null {
	const env = parseEnvelope(body);
	if (!env) return null;
	for (const item of env.items) {
		if (item.type !== 'event' && item.type !== 'transaction') continue;
		if (item.payload.length === 0 || item.payload.length > EVENT_MAX_BYTES) continue;
		try {
			const parsed = JSON.parse(new TextDecoder().decode(item.payload)) as Record<
				string,
				unknown
			> | null;
			if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return item.type === 'transaction'
					? { kind: 'transaction', transaction: parsed }
					: { kind: 'event', event: parsed };
			}
		} catch {
			continue;
		}
	}
	return null;
}

const TRACE_ID = /^[a-f0-9]{32}$/i;
const SPAN_ID = /^[a-f0-9]{16}$/i;
const SPAN_STATUS = /^[a-z_]{1,32}$/i;
const MAX_SPANS = 500;
const SPAN_DATA_MAX = 4096;

interface ParsedSpan {
	spanId: string;
	parentSpanId: string | null;
	op: string | null;
	description: string | null;
	startMs: number;
	endMs: number;
	status: string | null;
	data: string | null;
}

export interface ParsedTransaction {
	traceId: string;
	spanId: string | null;
	name: string;
	op: string | null;
	ts: number;
	durationMs: number;
	status: string | null;
	release: string | null;
	environment: string | null;
	spans: ParsedSpan[];
}

/** Sentry timestamps are seconds; clamp future values like events do. */
function msOf(v: unknown, now: number): number | null {
	if (typeof v !== 'number' || v <= 0) return null;
	return Math.min(Math.round(v * 1000), now + 60_000);
}

function statusOf(v: unknown): string | null {
	return typeof v === 'string' && SPAN_STATUS.test(v) ? v : null;
}

function normalizeSpan(raw: unknown, now: number): ParsedSpan | null {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
	// Span data/tags can carry secrets; scrub before anything persists.
	const s = scrub(raw) as Record<string, unknown>;
	if (typeof s.span_id !== 'string' || !SPAN_ID.test(s.span_id)) return null;
	const start = msOf(s.start_timestamp, now) ?? now;
	const end = msOf(s.timestamp, now) ?? start;
	const data: Record<string, unknown> = {};
	if (s.data && typeof s.data === 'object') data.data = s.data;
	if (s.tags && typeof s.tags === 'object') data.tags = s.tags;
	return {
		spanId: s.span_id.toLowerCase(),
		parentSpanId:
			typeof s.parent_span_id === 'string' && SPAN_ID.test(s.parent_span_id)
				? s.parent_span_id.toLowerCase()
				: null,
		op: typeof s.op === 'string' ? s.op.slice(0, 64) : null,
		description: typeof s.description === 'string' ? s.description.slice(0, 512) : null,
		startMs: start,
		endMs: Math.max(start, end),
		status: statusOf(s.status),
		data: Object.keys(data).length > 0 ? JSON.stringify(data).slice(0, SPAN_DATA_MAX) : null
	};
}

/**
 * Normalize a transaction event into a bounded trace + span rows.
 * Spans are scrubbed one at a time so the array cap in scrub() does
 * not truncate a legitimate waterfall. Returns null when the trace
 * context cannot identify the trace.
 */
export function normalizeTransaction(raw: Record<string, unknown>): ParsedTransaction | null {
	const { spans: rawSpans, ...rest } = raw;
	const clean = scrub(rest) as Record<string, unknown>;
	const ctx = clean.contexts as Record<string, unknown> | undefined;
	const trace = (ctx?.trace ?? {}) as Record<string, unknown>;
	if (typeof trace.trace_id !== 'string' || !TRACE_ID.test(trace.trace_id)) return null;
	const now = Date.now();
	const startMs = msOf(clean.start_timestamp, now) ?? now;
	const endMs = msOf(clean.timestamp, now) ?? startMs;
	const spans = (Array.isArray(rawSpans) ? rawSpans : [])
		.slice(0, MAX_SPANS)
		.map((s) => normalizeSpan(s, now))
		.filter((s): s is ParsedSpan => s !== null)
		.sort((a, b) => a.startMs - b.startMs);
	return {
		traceId: trace.trace_id.toLowerCase(),
		spanId:
			typeof trace.span_id === 'string' && SPAN_ID.test(trace.span_id)
				? trace.span_id.toLowerCase()
				: null,
		name:
			typeof clean.transaction === 'string' && clean.transaction.length > 0
				? clean.transaction.slice(0, 256)
				: '<unnamed>',
		op: typeof trace.op === 'string' ? trace.op.slice(0, 64) : null,
		ts: startMs,
		durationMs: Math.max(0, endMs - startMs),
		status: statusOf(trace.status),
		release: typeof clean.release === 'string' ? clean.release.slice(0, 256) : null,
		environment: typeof clean.environment === 'string' ? clean.environment.slice(0, 128) : null,
		spans
	};
}

/** Does this DSN key resolve to a live project? */
export async function resolveProject(
	store: { projectByKey(key: string): Promise<TelemetryProject | null> },
	projectId: string,
	key: string | null
): Promise<TelemetryProject | null> {
	if (!key || !/^\d+$/.test(projectId)) return null;
	const p = await store.projectByKey(key);
	if (p === null) return null;
	if (p.disabledAt !== null || String(p.id) !== projectId) return null;
	return p;
}
