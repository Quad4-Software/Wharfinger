import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { publicKeyB64 } from '$lib/server/ingress/keys';
import { agentView } from '$lib/server/ingress/view';

export const GET: RequestHandler = async (event) => {
	// Host intel (meta, versions, service counts) is infra-admin data,
	// same scope as token management: agents.manage, not bare auth.
	requirePerm(event, 'agents.manage');
	const rt = getRuntime();
	const window = rt.config.ingress.online_seconds * 1000;
	const agents = await rt.agents.list();
	return apiJson({
		agents: agents.map((a) => agentView(a, window)),
		pubkey: await publicKeyB64(rt.db),
		enabled: rt.config.ingress.enabled
	});
};

/** Register a system. The bearer token is returned exactly once. */
export const POST: RequestHandler = async (event) => {
	const actor = requirePerm(event, 'agents.manage');
	const rt = getRuntime();
	const body = await readJson<{ name?: unknown }>(event.request, 8192);
	const name = typeof body.name === 'string' ? body.name.trim() : '';
	if (!name || name.length > 80) return apiError(422, 'name is required (max 80 chars)');

	const { id, token } = await rt.agents.create(name, String(actor.id));
	await audit(rt, event, 'agents.create', `id=${id} name=${name}`);
	return apiJson(
		{
			id,
			token,
			pubkey: await publicKeyB64(rt.db),
			ingress: `${event.url.origin}/ingress`,
			ws: `${event.url.origin}/ingress/ws`
		},
		201
	);
};
