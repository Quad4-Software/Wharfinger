import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getRuntime } from '$lib/server/runtime';
import { clientIp } from '$lib/server/admin/http';
import {
	EVENT_MAX_BYTES,
	eventToEnvelope,
	normalizeEvent,
	resolveProject,
	sentryKey,
	scrubEnvelope
} from '$lib/server/telemetry/ingest';
import {
	ingestDup,
	ingestIpAllowed,
	ingestProjectAllowed,
	maybeStartFlush,
	relayEnqueue,
	spoolEnqueue
} from '$lib/server/telemetry/pipeline';

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'POST, OPTIONS',
	'access-control-allow-headers': 'content-type, x-sentry-auth, authorization'
};

const err = (status: number, message: string, extra?: Record<string, string>) =>
	json({ error: message }, { status, headers: { ...CORS, ...extra } });

// Legacy single-event endpoint: /api/<projectId>/store/
// Non-local modes wrap the body into a one-item envelope so the spool
// and the upstream forwarder speak a single wire format.
export const OPTIONS: RequestHandler = () => new Response(null, { status: 204, headers: CORS });

export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const ing = rt.config.telemetry.ingest;
	if (!ingestIpAllowed(ing, clientIp(event))) {
		return err(429, 'rate limit exceeded', { 'retry-after': '60' });
	}
	const project = await resolveProject(
		rt.telemetry,
		event.params.project,
		sentryKey(event.request)
	);
	if (!project) return err(401, 'invalid DSN key or project');
	if (!ingestProjectAllowed(ing, project.id)) {
		return err(429, 'rate limit exceeded', { 'retry-after': '60' });
	}

	const len = Number(event.request.headers.get('content-length') ?? 0);
	if (len > EVENT_MAX_BYTES) return err(413, 'event too large');
	const text = await event.request.text();
	if (text.length > EVENT_MAX_BYTES) return err(413, 'event too large');
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return err(422, 'invalid event json');
	}
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return err(422, 'invalid event json');
	}
	const body = raw as Record<string, unknown>;
	const eventId = typeof body.event_id === 'string' ? body.event_id.slice(0, 64) : null;

	if (ing.mode === 'relay' || ing.mode === 'queue') {
		if (eventId !== null && ingestDup(project.id, eventId)) {
			return json({ id: eventId }, { headers: CORS });
		}
		const envelope = eventToEnvelope(body);
		if (ing.mode === 'relay') {
			// A just-built envelope always parses; scrub before it
			// leaves the node so filtered fields stay local.
			const r = relayEnqueue(rt, ing, scrubEnvelope(envelope) ?? envelope);
			if (r === 'misconfigured') return err(503, 'relay upstream not configured');
			if (r === 'full') return err(429, 'relay buffer full', { 'retry-after': '10' });
			return json({ id: eventId }, { headers: CORS });
		}
		if (spoolEnqueue(ing, project.id, eventId, envelope) === 'full') {
			return err(429, 'ingest queue full', { 'retry-after': '10' });
		}
		maybeStartFlush(rt);
		return json({ id: eventId }, { headers: CORS });
	}

	const e = normalizeEvent(body);
	if (e.eventId !== null && ingestDup(project.id, e.eventId)) {
		return json({ id: e.eventId }, { headers: CORS });
	}
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
	maybeStartFlush(rt);
	return json({ id: e.eventId }, { headers: CORS });
};
