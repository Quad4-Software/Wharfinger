import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { DeployError } from '$lib/server/deploy/store';

/** Rotate the webhook token or the deploy key; the new value shows once. */
export const POST: RequestHandler = async (event) => {
	requirePerm(event, 'deploy.manage');
	const rt = getRuntime();
	if (!rt.deploys.getApp(event.params.id)) return apiError(404, 'app not found');
	const body = await readJson<{ what?: unknown }>(event.request, 8192);
	try {
		if (body.what === 'webhook') {
			const token = rt.deploys.rotateWebhook(event.params.id);
			audit(rt, event, 'deploy.webhook.rotate', `app=${event.params.id}`);
			return apiJson({ ok: true, webhook: `${event.url.origin}/api/deploy/hook/${token}` });
		}
		if (body.what === 'key') {
			const pub = rt.deploys.rotateDeployKey(event.params.id);
			audit(rt, event, 'deploy.key.rotate', `app=${event.params.id}`);
			return apiJson({ ok: true, deployKeyPub: pub });
		}
		return apiError(422, 'expected what=webhook or what=key');
	} catch (err) {
		if (err instanceof DeployError) return apiError(err.status, err.message);
		throw err;
	}
};
