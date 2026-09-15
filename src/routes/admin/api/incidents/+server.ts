import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { SectionError, saveSectionValue } from '$lib/server/admin/config-actions';
import {
	apiError,
	apiJson,
	asArray,
	asString,
	clientIp,
	readJson,
	requirePerm
} from '$lib/server/admin/http';

export const GET: RequestHandler = async (event) => {
	const rt = getRuntime();
	requirePerm(event, 'status.view');
	return apiJson((await rt.snapshot.current()).snapshot.incidents);
};

/** Create a manual incident; stored in the incidents config section. */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requirePerm(event, 'status.manage');
	const body = await readJson<{
		title?: unknown;
		severity?: unknown;
		services?: unknown;
		message?: unknown;
	}>(event.request, 32 * 1024);

	const title = asString(body.title, 200);
	if (body.severity !== undefined && body.severity !== 'minor' && body.severity !== 'major') {
		return apiError(422, 'severity must be minor or major');
	}
	const severity = body.severity === 'major' ? 'major' : 'minor';
	const services = Array.isArray(body.services)
		? body.services.filter((s): s is string => typeof s === 'string')
		: [];
	const message = asString(body.message, 2000);
	if (!title) return apiError(422, 'title is required');
	if (services.length === 0) return apiError(422, 'select at least one service');

	const now = new Date().toISOString();
	const raw = rt.effective().raw;
	const incidents = asArray(raw.incidents);
	incidents.push({
		title,
		severity,
		services,
		started_at: now,
		...(message ? { updates: [{ at: now, message }] } : {})
	});

	try {
		await saveSectionValue(
			rt,
			user,
			clientIp(event),
			'incidents',
			incidents,
			undefined,
			'incident.create'
		);
	} catch (err) {
		if (err instanceof SectionError) {
			return apiError(err.status, err.message, err.issues ? { issues: err.issues } : undefined);
		}
		throw err;
	}
	void rt.dispatcher.notify({
		event: 'incident',
		serviceName: title,
		detail: message
	});
	return apiJson({ ok: true }, 201);
};
