import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { captureClientReport } from '$lib/server/telemetry';
import { sanitizeClientReport } from '$lib/shared/telemetry';
import { readJson } from '$lib/server/admin/http';

/**
 * Browser error relay. Clients POST sanitized crash reports here instead
 * of talking to the Sentry backend directly, so the dsn stays server
 * side and CSP can keep connect-src 'self'. The /api/ prefix already
 * applies the public rate limiter in hooks.
 */
export const POST: RequestHandler = async (event) => {
	const t = getRuntime().config.telemetry;
	if (!t.enabled || !t.client_reports || t.dsn === '') {
		return new Response(null, { status: 204 });
	}
	const report = sanitizeClientReport(await readJson(event.request, 32 * 1024));
	if (!report) {
		return new Response(JSON.stringify({ error: 'invalid report' }), {
			status: 422,
			headers: { 'content-type': 'application/json' }
		});
	}
	captureClientReport(report, event.request.headers.get('user-agent'));
	return new Response(null, { status: 204 });
};
