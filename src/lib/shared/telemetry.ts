import { paths } from './paths';

// Wire type for browser error reports posted to /api/telemetry. The
// server maps it onto a Sentry event; keeping the shape small and
// string-only makes sanitization trivial.
export interface ClientErrorReport {
	name: string;
	message: string;
	stack?: string;
	/** Full page URL; the server strips query and fragment. */
	url?: string;
	routeId?: string;
	status?: number;
	/** False for unhandled crashes, true for caught boundary errors. */
	handled?: boolean;
	/** What caught the error, e.g. sveltekit.handleError. */
	mechanism?: string;
	extra?: Record<string, string>;
}

const MAX_MESSAGE = 2048;
const MAX_STACK = 16 * 1024;
const MAX_EXTRAS = 20;

function clipped(v: unknown, max: number): string | undefined {
	if (typeof v !== 'string' || v.length === 0) return undefined;
	return v.length > max ? `${v.slice(0, max)}...[truncated]` : v;
}

/** Coerce an unknown POST body into a bounded report, or null. */
export function sanitizeClientReport(input: unknown): ClientErrorReport | null {
	if (input === null || typeof input !== 'object') return null;
	const o = input as Record<string, unknown>;
	const message = clipped(o.message, MAX_MESSAGE);
	if (!message) return null;
	const report: ClientErrorReport = {
		name: clipped(o.name, 200) ?? 'Error',
		message
	};
	const stack = clipped(o.stack, MAX_STACK);
	if (stack) report.stack = stack;
	const url = clipped(o.url, 2048);
	if (url) report.url = url;
	const routeId = clipped(o.routeId, 200);
	if (routeId) report.routeId = routeId;
	if (typeof o.status === 'number' && Number.isInteger(o.status)) report.status = o.status;
	if (typeof o.handled === 'boolean') report.handled = o.handled;
	const mechanism = clipped(o.mechanism, 100);
	if (mechanism) report.mechanism = mechanism;
	if (o.extra !== null && typeof o.extra === 'object') {
		const extra: Record<string, string> = {};
		for (const [k, val] of Object.entries(o.extra as Record<string, unknown>)) {
			if (Object.keys(extra).length >= MAX_EXTRAS) break;
			const v = clipped(val, 500);
			if (typeof k === 'string' && k.length > 0 && k.length <= 40 && v) extra[k] = v;
		}
		if (Object.keys(extra).length > 0) report.extra = extra;
	}
	return report;
}

// Browser-side sender. Dedupes identical reports and caps the total per
// page load so a crash loop cannot flood the relay endpoint.
const sent = new Set<string>();
let sentCount = 0;

/** Fire-and-forget POST of a browser error. Never throws. */
export function sendClientReport(report: ClientErrorReport): void {
	try {
		const fp = `${report.name}:${report.message}:${report.url ?? ''}`;
		if (sent.has(fp) || sentCount >= 10) return;
		sent.add(fp);
		sentCount += 1;
		void fetch(paths.apiTelemetry, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(report),
			keepalive: true
		}).catch(() => undefined);
	} catch {
		// Reporting must never throw into the app it watches.
	}
}
