import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { DeployError } from '$lib/server/deploy/store';
import type { AppSource, DeployRuntime, Healthcheck, PortMap } from '$lib/shared/deploy';

export const GET: RequestHandler = async (event) => {
	requirePerm(event, 'deploy.view');
	const rt = getRuntime();
	return apiJson({ apps: await rt.deploys.listApps() });
};

interface CreateBody {
	name?: unknown;
	agentId?: unknown;
	source?: unknown;
	runtime?: unknown;
	domains?: unknown;
	healthcheck?: unknown;
	ports?: unknown;
	namespace?: unknown;
	replicas?: unknown;
	env?: unknown;
}

export const POST: RequestHandler = async (event) => {
	requirePerm(event, 'deploy.manage');
	const rt = getRuntime();
	const body = await readJson<CreateBody>(event.request, 64 * 1024);

	const agentId = typeof body.agentId === 'string' ? body.agentId : '';
	if (!(await rt.agents.get(agentId))) return apiError(422, 'target agent not found');

	const domains = Array.isArray(body.domains) ? body.domains.map(String) : [];
	try {
		const { app, webhook, deployKeyPub } = await rt.deploys.createApp({
			name: typeof body.name === 'string' ? body.name : '',
			agentId,
			source: body.source as AppSource,
			runtime: body.runtime as DeployRuntime | undefined,
			domains,
			healthcheck: body.healthcheck as Healthcheck | undefined,
			ports: Array.isArray(body.ports) ? (body.ports as PortMap[]) : undefined,
			namespace: body.namespace === null ? null : (body.namespace as string | undefined),
			replicas: body.replicas === null ? null : (body.replicas as number | undefined)
		});
		if (body.env && typeof body.env === 'object') {
			await rt.deploys.setEnv(app.id, body.env as Record<string, string>);
		}
		await audit(rt, event, 'deploy.app.create', `app=${app.id} name=${app.name} agent=${agentId}`);
		return apiJson(
			{
				ok: true,
				app: await rt.deploys.getApp(app.id),
				webhook: `${event.url.origin}/api/deploy/hook/${webhook}`,
				deployKeyPub
			},
			201
		);
	} catch (err) {
		if (err instanceof DeployError) return apiError(err.status, err.message);
		throw err;
	}
};
