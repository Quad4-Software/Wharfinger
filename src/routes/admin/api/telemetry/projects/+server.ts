import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, asString, readJson, requirePerm } from '$lib/server/admin/http';

/** List telemetry projects (with per-project event/issue counts). */
export const GET: RequestHandler = async (event) => {
	requirePerm(event, 'telemetry.view');
	const rt = getRuntime();
	const projects = (await rt.telemetry.projects()).map((p) => ({
		...p,
		publicKey: undefined,
		key: p.publicKey,
		// Sentry DSN: SDKs derive /api/<id>/envelope/ from this.
		dsn: `${event.url.protocol}//${p.publicKey}@${event.url.host}/${p.id}`
	}));
	return apiJson({ projects });
};

/** Create a project; returns the DSN once. */
export const POST: RequestHandler = async (event) => {
	requirePerm(event, 'telemetry.manage');
	const rt = getRuntime();
	const body = await readJson<{ name?: unknown; platform?: unknown }>(event.request, 4096);
	const name = asString(body.name, 80);
	if (!name) return apiError(422, 'name required');
	if ((await rt.telemetry.projects()).length >= 100) return apiError(422, 'project limit reached');
	const p = await rt.telemetry.createProject(name, asString(body.platform, 40));
	await audit(rt, event, 'telemetry.project.create', name);
	return apiJson({
		project: {
			...p,
			publicKey: undefined,
			key: p.publicKey,
			dsn: `${event.url.protocol}//${p.publicKey}@${event.url.host}/${p.id}`
		}
	});
};
