import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getRuntime } from '$lib/server/runtime';
import {
	EVENT_MAX_BYTES,
	normalizeEvent,
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

// Legacy single-event endpoint: /api/<projectId>/store/
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

	const e = normalizeEvent(raw as Record<string, unknown>);
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
	return json({ id: e.eventId }, { headers: CORS });
};
