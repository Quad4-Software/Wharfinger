import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { agentView } from '$lib/server/ingress/view';

export const GET: RequestHandler = (event) => {
	// The full payload carries ports, process names, container images,
	// banned IPs, and the fingerprint: recon-grade host data scoped to
	// agents.manage like the token endpoints.
	requirePerm(event, 'agents.manage');
	const rt = getRuntime();
	const agent = rt.agents.get(event.params.id);
	if (!agent) return apiError(404, 'agent not found');
	return apiJson({
		agent: agentView(agent, rt.config.ingress.online_seconds * 1000),
		payload: agent.lastPayload
	});
};

/** Rename a system. */
export const PATCH: RequestHandler = async (event) => {
	requirePerm(event, 'agents.manage');
	const rt = getRuntime();
	const agent = rt.agents.get(event.params.id);
	if (!agent) return apiError(404, 'agent not found');
	const body = await readJson<{ name?: unknown }>(event.request, 8192);
	const name = typeof body.name === 'string' ? body.name.trim() : '';
	if (!name || name.length > 80) return apiError(422, 'name is required (max 80 chars)');
	rt.db.prepare('UPDATE agents SET name = ? WHERE id = ?').run(name, agent.id);
	audit(rt, event, 'agents.rename', `id=${agent.id} name=${name}`);
	return apiJson({ ok: true });
};

/** Revoke a system: token dies immediately, samples are kept. */
export const DELETE: RequestHandler = (event) => {
	requirePerm(event, 'agents.manage');
	const rt = getRuntime();
	const agent = rt.agents.get(event.params.id);
	if (!agent) return apiError(404, 'agent not found');
	rt.agents.revoke(agent.id);
	audit(rt, event, 'agents.revoke', `id=${agent.id} name=${agent.name}`);
	return apiJson({ ok: true });
};
