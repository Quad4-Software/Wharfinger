import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getRuntime } from '$lib/server/runtime';
import {
	ENVELOPE_MAX_BYTES,
	itemFromEnvelope,
	normalizeEvent,
	normalizeTransaction,
	resolveProject,
	sentryKey
} from '$lib/server/telemetry/ingest';

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'POST, OPTIONS',
	'access-control-allow-headers': 'content-type, x-sentry-auth, authorization'
};

const err = (status: number, message: string) =>
	json({ error: message }, { status, headers: CORS });

// A new release string is a deploy: drop a chart marker the first
// time each value shows up so latency/uptime graphs get the line.
async function markRelease(
	rt: ReturnType<typeof getRuntime>,
	release: string | null
): Promise<void> {
	if (!release) return;
	const title = `release ${release}`.slice(0, 256);
	if (await rt.markers.exists(title, 0)) return;
	await rt.markers.add({ title, kind: 'release', source: 'telemetry' });
}

// Sentry envelope ingest: /api/<projectId>/envelope/
// Browser SDKs preflight; the body cap rejects floods before parsing.
export const OPTIONS: RequestHandler = () => new Response(null, { status: 204, headers: CORS });

export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const project = await resolveProject(
		rt.telemetry,
		event.params.project,
		sentryKey(event.request)
	);
	if (!project) return err(401, 'invalid DSN key or project');

	const len = Number(event.request.headers.get('content-length') ?? 0);
	if (len > ENVELOPE_MAX_BYTES) return err(413, 'envelope too large');
	const body = new Uint8Array(await event.request.arrayBuffer());
	if (body.length > ENVELOPE_MAX_BYTES) return err(413, 'envelope too large');

	const item = itemFromEnvelope(body);
	if (!item) return err(422, 'no event item in envelope');

	// Transactions are performance data, not errors: they land in the
	// trace store and never create issues.
	if (item.kind === 'transaction') {
		const t = normalizeTransaction(item.transaction);
		if (!t) return err(422, 'invalid transaction payload');
		await rt.telemetry.recordTrace({ projectId: project.id, ...t });
		await markRelease(rt, t.release);
		return json({ id: t.traceId }, { headers: CORS });
	}

	const e = normalizeEvent(item.event);
	await rt.telemetry.record({
		projectId: project.id,
		fingerprint: e.fingerprint,
		title: e.title,
		culprit: e.culprit,
		level: e.level,
		eventId: e.eventId,
		ts: e.ts,
		platform: e.platform,
		message: e.message,
		excType: e.excType,
		excValue: e.excValue,
		release: e.release,
		environment: e.environment,
		tags: e.tags,
		request: e.request,
		stack: e.stack,
		raw: e.raw
	});
	await markRelease(rt, e.release);
	return json({ id: e.eventId }, { headers: CORS });
};
