import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { DeployError } from '$lib/server/deploy/store';
import type { AppSource, DeployRuntime, Healthcheck, PortMap } from '$lib/shared/deploy';

export const GET: RequestHandler = (event) => {
	requirePerm(event, 'deploy.view');
	const rt = getRuntime();
	const app = rt.deploys.getApp(event.params.id);
	if (!app) return apiError(404, 'app not found');
	const live = rt.deploys.liveRelease(app.id);
	return apiJson({ app, live, releases: rt.deploys.releases(app.id) });
};

export const PATCH: RequestHandler = async (event) => {
	const actor = requirePerm(event, 'deploy.manage');
	const rt = getRuntime();
	const body = await readJson<{
		name?: unknown;
		agentId?: unknown;
		source?: unknown;
		runtime?: unknown;
		domains?: unknown;
		healthcheck?: unknown;
		ports?: unknown;
		namespace?: unknown;
		replicas?: unknown;
		hookSecret?: unknown;
		expectedUpdatedAt?: unknown;
	}>(event.request, 64 * 1024);
	try {
		const app = rt.deploys.updateApp(event.params.id, {
			name: body.name as string | undefined,
			agentId: body.agentId as string | undefined,
			source: body.source as AppSource | undefined,
			runtime: body.runtime as DeployRuntime | undefined,
			domains: Array.isArray(body.domains) ? body.domains.map(String) : undefined,
			healthcheck: body.healthcheck as Healthcheck | undefined,
			ports: Array.isArray(body.ports) ? (body.ports as PortMap[]) : undefined,
			namespace: body.namespace === undefined ? undefined : (body.namespace as string | null),
			replicas: body.replicas === undefined ? undefined : (body.replicas as number | null),
			expectedUpdatedAt:
				typeof body.expectedUpdatedAt === 'number' ? body.expectedUpdatedAt : undefined
		});
		if (typeof body.hookSecret === 'string' && body.hookSecret) {
			rt.deploys.setHookSecret(app.id, body.hookSecret.slice(0, 256));
		}
		audit(rt, event, 'deploy.app.update', `app=${app.id} actor=${actor.id}`);
		return apiJson({ ok: true, app });
	} catch (err) {
		if (err instanceof DeployError) return apiError(err.status, err.message);
		throw err;
	}
};

export const DELETE: RequestHandler = (event) => {
	requirePerm(event, 'deploy.manage');
	const rt = getRuntime();
	if (!rt.deploys.deleteApp(event.params.id)) return apiError(404, 'app not found');
	audit(rt, event, 'deploy.app.delete', `app=${event.params.id}`);
	return apiJson({ ok: true });
};
