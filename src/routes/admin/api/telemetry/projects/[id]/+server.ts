import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';

function projectId(raw: string): number | null {
	const id = Number(raw);
	return Number.isInteger(id) && id > 0 ? id : null;
}

/** Disable or re-enable a project's DSN. */
export const PATCH: RequestHandler = async (event) => {
	requirePerm(event, 'telemetry.manage');
	const rt = getRuntime();
	const id = projectId(event.params.id);
	const p = id === null ? null : await rt.telemetry.project(id);
	if (!p) return apiError(404, 'unknown project');
	const body = await readJson<{ disabled?: unknown }>(event.request, 2048);
	await rt.telemetry.setProjectDisabled(p.id, body.disabled === true);
	await audit(
		rt,
		event,
		'telemetry.project.toggle',
		`${p.name}: ${body.disabled === true ? 'disabled' : 'enabled'}`
	);
	return apiJson({ ok: true });
};

/** Delete a project and all its events. */
export const DELETE: RequestHandler = async (event) => {
	requirePerm(event, 'telemetry.manage');
	const rt = getRuntime();
	const id = projectId(event.params.id);
	const p = id === null ? null : await rt.telemetry.project(id);
	if (!p) return apiError(404, 'unknown project');
	await rt.telemetry.deleteProject(p.id);
	await audit(rt, event, 'telemetry.project.delete', p.name);
	return apiJson({ ok: true });
};
