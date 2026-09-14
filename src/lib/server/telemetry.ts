import { hostname, platform, release as kernelRelease } from 'node:os';
import { version } from '$app/environment';
import type { StatusConfig } from './config/schema';
import type { ClientErrorReport } from '$lib/shared/telemetry';

// Minimal Sentry-protocol reporter. Sentry, GlitchTip, and Bugsink all
// accept the same envelope endpoint, so one implementation covers all
// three with no SDK dependency.

type TelemetryConfig = StatusConfig['telemetry'];

interface Dsn {
	raw: string;
	endpoint: string;
	publicKey: string;
	projectId: string;
}

/**
 * Parse a Sentry dsn into its envelope endpoint and public key. The
 * last path segment is the project id; anything before it is a mount
 * prefix (GlitchTip/Bugsink behind a subpath), preserved in the
 * endpoint. An optional secret in the password position is ignored:
 * modern ingest authenticates on the public key alone.
 */
function parseDsn(dsn: string): Dsn | null {
	try {
		const u = new URL(dsn);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
		const segs = u.pathname.replace(/\/+$/g, '').split('/').filter(Boolean);
		const projectId = segs.at(-1) ?? '';
		if (!u.username || !projectId || !/^\w+$/.test(projectId)) return null;
		const prefix = segs.slice(0, -1).join('/');
		return {
			raw: dsn,
			endpoint: `${u.origin}${prefix ? `/${prefix}` : ''}/api/${projectId}/envelope/`,
			publicKey: u.username,
			projectId
		};
	} catch {
		return null;
	}
}

/**
 * Strip query and fragment so reported URLs never leak tokens (invite
 * links live in the query and admin paths can carry secrets).
 */
export function scrubUrl(raw: string): string {
	try {
		const u = new URL(raw);
		return `${u.origin}${u.pathname}`;
	} catch {
		return raw.split(/[?#]/)[0] ?? raw;
	}
}

let getConfig: (() => TelemetryConfig) | null = null;

/**
 * Point the reporter at live config. Called once by getRuntime(); the
 * getter re-reads on every event so config reloads apply without a
 * restart.
 */
export function bindTelemetry(getter: () => TelemetryConfig): void {
	getConfig = getter;
}

const SDK = { name: 'wharfinger', version };
const RELEASE = `wharfinger@${version}`;

export interface EventContext {
	level?: 'fatal' | 'error' | 'warning' | 'info';
	tags?: Record<string, string>;
	extra?: Record<string, unknown>;
	request?: { url: string; method?: string; headers?: Record<string, string> };
}

interface Frame {
	filename: string;
	function?: string;
	lineno?: number;
	colno?: number;
	in_app: boolean;
	abs_path?: string;
}

const FRAME_RE = /^\s*at\s+(?:(.*?)\s+\()?([^()]+):(\d+):(\d+)\)?\s*$/;
const MAX_FRAMES = 50;

/** V8 stack text to Sentry frames (oldest first, app frames flagged). */
function parseStack(stack: string | undefined): Frame[] {
	if (!stack) return [];
	const cwd = process.cwd();
	const frames: Frame[] = [];
	for (const line of stack.split('\n')) {
		const m = FRAME_RE.exec(line);
		if (!m) continue;
		const abs = m[2].trim();
		if (abs.startsWith('node:')) continue;
		const path = abs.startsWith('file://') ? abs.slice(7) : abs;
		const filename = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
		const fn = (m[1] as string | undefined)?.trim().replace(/^async\s+/, '');
		frames.push({
			filename,
			...(fn ? { function: fn } : {}),
			lineno: Number(m[3]),
			colno: Number(m[4]),
			in_app: !filename.includes('node_modules'),
			abs_path: path
		});
		if (frames.length >= MAX_FRAMES) break;
	}
	return frames.reverse();
}

function normalizeError(error: unknown): { name: string; message: string; stack?: string } {
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack };
	}
	return { name: 'Error', message: typeof error === 'string' ? error : JSON.stringify(error) };
}

// Dedup + rate cap: one copy of each fingerprint per minute, and a
// configurable ceiling on total events per minute.
const fingerprints = new Map<string, number>();
let windowStart = 0;
let windowCount = 0;

function throttled(fp: string, maxPerMinute: number): boolean {
	const now = Date.now();
	if (now - windowStart > 60_000) {
		windowStart = now;
		windowCount = 0;
	}
	if (windowCount >= maxPerMinute) return true;
	const last = fingerprints.get(fp);
	if (last !== undefined && now - last < 60_000) return true;
	if (fingerprints.size > 1000) {
		for (const [k, t] of fingerprints) {
			if (now - t > 60_000) fingerprints.delete(k);
		}
	}
	fingerprints.set(fp, now);
	windowCount += 1;
	return false;
}

function baseEvent(cfg: TelemetryConfig, level: string): Record<string, unknown> {
	return {
		event_id: crypto.randomUUID().replaceAll('-', ''),
		timestamp: Date.now() / 1000,
		platform: 'node',
		level,
		logger: 'wharfinger',
		release: RELEASE,
		environment: cfg.environment,
		sdk: SDK,
		server_name: hostname(),
		contexts: {
			runtime: { name: 'node', version: process.version },
			os: { name: platform(), kernel_version: kernelRelease() }
		}
	};
}

/** POST one event envelope. Returns the ingest response. */
async function send(dsn: Dsn, event: Record<string, unknown>): Promise<Response> {
	const eventJson = JSON.stringify(event);
	const envelope = [
		JSON.stringify({
			event_id: event.event_id,
			dsn: dsn.raw,
			sdk: SDK,
			sent_at: new Date().toISOString()
		}),
		JSON.stringify({ type: 'event', length: eventJson.length }),
		eventJson
	].join('\n');
	return fetch(dsn.endpoint, {
		method: 'POST',
		headers: {
			'content-type': 'application/x-sentry-envelope',
			'x-sentry-auth': [
				'Sentry sentry_version=7',
				`sentry_client=${SDK.name}/${SDK.version}`,
				`sentry_timestamp=${Math.floor(Date.now() / 1000)}`,
				`sentry_key=${dsn.publicKey}`
			].join(', ')
		},
		body: envelope,
		signal: AbortSignal.timeout(10_000)
	});
}

function active(cfg: TelemetryConfig | undefined): cfg is TelemetryConfig {
	return cfg !== undefined && cfg.enabled && cfg.dsn !== '';
}

function deliver(event: Record<string, unknown>, cfg: TelemetryConfig, fp: string): void {
	if (throttled(fp, cfg.max_per_minute)) return;
	const dsn = parseDsn(cfg.dsn);
	if (!dsn) {
		console.warn('[telemetry] dsn is malformed, dropping event');
		return;
	}
	send(dsn, event).catch((err: unknown) => {
		console.warn('[telemetry] delivery failed:', err instanceof Error ? err.message : String(err));
	});
}

/** Report a server-side exception. Fire-and-forget; never throws. */
export function captureException(error: unknown, ctx: EventContext = {}): void {
	try {
		const cfg = getConfig?.();
		if (!active(cfg)) return;
		const err = normalizeError(error);
		const frames = parseStack(err.stack);
		const top = frames.at(-1);
		const fp = `${err.name}:${err.message}:${top?.filename ?? ''}:${top?.lineno ?? ''}`;
		deliver(
			{
				...baseEvent(cfg, ctx.level ?? 'error'),
				exception: {
					values: [{ type: err.name, value: err.message, stacktrace: { frames } }]
				},
				tags: { side: 'server', ...ctx.tags },
				...(ctx.request ? { request: ctx.request } : {}),
				...(ctx.extra ? { extra: ctx.extra } : {})
			},
			cfg,
			fp
		);
	} catch {
		// Telemetry is best-effort; a broken reporter must not break the app.
	}
}

/** Forward a browser error report received via /api/telemetry. */
export function captureClientReport(report: ClientErrorReport, userAgent: string | null): void {
	try {
		const cfg = getConfig?.();
		if (!active(cfg) || !cfg.client_reports) return;
		const tags: Record<string, string> = { side: 'client' };
		if (report.routeId) tags.route = report.routeId;
		if (report.mechanism) tags.mechanism = report.mechanism;
		if (report.status !== undefined) tags.status = String(report.status);
		if (report.handled !== undefined) tags.handled = String(report.handled);
		deliver(
			{
				...baseEvent(cfg, 'error'),
				platform: 'javascript',
				server_name: undefined,
				exception: {
					values: [
						{
							type: report.name,
							value: report.message,
							mechanism: {
								type: report.mechanism ?? 'onerror',
								handled: report.handled ?? false
							},
							stacktrace: { frames: parseStack(report.stack) }
						}
					]
				},
				tags,
				request: {
					...(report.url ? { url: scrubUrl(report.url) } : {}),
					headers: { 'user-agent': userAgent ?? '' }
				},
				contexts: { browser: { name: 'browser' } },
				...(report.extra ? { extra: report.extra } : {})
			},
			cfg,
			`client:${report.name}:${report.message}:${report.url ?? ''}`
		);
	} catch {
		// Best-effort only.
	}
}

/** Send a test event and report the ingest result, for the admin panel. */
export async function sendTestEvent(): Promise<{ ok: boolean; error?: string }> {
	const cfg = getConfig?.();
	if (!active(cfg)) return { ok: false, error: 'telemetry is disabled or dsn is empty' };
	const dsn = parseDsn(cfg.dsn);
	if (!dsn) return { ok: false, error: 'dsn is malformed' };
	try {
		const res = await send(dsn, {
			...baseEvent(cfg, 'info'),
			message: 'wharfinger test event',
			tags: { side: 'server', source: 'admin-test' }
		});
		if (!res.ok) return { ok: false, error: `ingest returned HTTP ${res.status}` };
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'delivery failed' };
	}
}
