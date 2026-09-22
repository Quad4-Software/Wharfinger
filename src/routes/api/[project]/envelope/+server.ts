import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getRuntime } from '$lib/server/runtime';
import { clientIp } from '$lib/server/admin/http';
import {
	ENVELOPE_MAX_BYTES,
	envelopeEventId,
	itemFromEnvelope,
	resolveProject,
	sentryKey,
	scrubEnvelope
} from '$lib/server/telemetry/ingest';
import {
	ingestDup,
	ingestIpAllowed,
	ingestProjectAllowed,
	maybeStartFlush,
	persistItem,
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

// Sentry envelope ingest: /api/<projectId>/envelope/
// Browser SDKs preflight; the body cap rejects floods before parsing.
// [telemetry.ingest].mode picks the pipeline: local writes to the db
// here, relay scrubs and forwards upstream, queue spools to disk.
export const OPTIONS: RequestHandler = () => new Response(null, { status: 204, headers: CORS });

export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const ing = rt.config.telemetry.ingest;
	// The ip bucket runs before project resolution so floods do not
	// reach the db; the project bucket runs once the key resolves.
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
	if (len > ENVELOPE_MAX_BYTES) return err(413, 'envelope too large');
	const body = new Uint8Array(await event.request.arrayBuffer());
	if (body.length > ENVELOPE_MAX_BYTES) return err(413, 'envelope too large');

	// Relay mode: scrub every JSON item payload before it leaves the
	// node, then buffer for upstream forwarding. The client gets 200
	// once the envelope is buffered, matching store-and-forward
	// ingest semantics; the raw event ids survive re-encoding.
	if (ing.mode === 'relay') {
		const clean = scrubEnvelope(body);
		if (clean === null) return err(422, 'invalid envelope');
		const eventId = envelopeEventId(body);
		if (eventId !== null && ingestDup(project.id, eventId)) {
			return json({ id: eventId }, { headers: CORS });
		}
		const r = relayEnqueue(rt, ing, clean);
		if (r === 'misconfigured') return err(503, 'relay upstream not configured');
		if (r === 'full') return err(429, 'relay buffer full', { 'retry-after': '10' });
		return json({ id: eventId }, { headers: CORS });
	}

	// Queue mode: validate the envelope carries an event or
	// transaction item, then spool it durably; a background flush
	// feeds the same persist path local mode uses.
	if (ing.mode === 'queue') {
		const item = itemFromEnvelope(body);
		if (!item) return err(422, 'no event item in envelope');
		const payload = item.kind === 'event' ? item.event : item.transaction;
		const eventId =
			(typeof payload.event_id === 'string' ? payload.event_id.slice(0, 64) : null) ??
			envelopeEventId(body);
		if (eventId !== null && ingestDup(project.id, eventId)) {
			return json({ id: eventId }, { headers: CORS });
		}
		if (spoolEnqueue(ing, project.id, eventId, body) === 'full') {
			return err(429, 'ingest queue full', { 'retry-after': '10' });
		}
		maybeStartFlush(rt);
		return json({ id: eventId }, { headers: CORS });
	}

	const item = itemFromEnvelope(body);
	if (!item) return err(422, 'no event item in envelope');

	const r = await persistItem(rt, project.id, item);
	if (r.status === 'invalid') return err(422, 'invalid transaction payload');
	maybeStartFlush(rt);
	return json({ id: r.id }, { headers: CORS });
};
