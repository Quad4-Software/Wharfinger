import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, requirePerm } from '$lib/server/admin/http';
import { domainCheck } from '$lib/server/deploy/dns';

/**
 * DNS preflight for the app's domains: resolution, wildcard probes,
 * agent-address comparison, and cross-app conflicts. Read-only; the
 * lookups go to the system resolver with a bounded timeout.
 */
export const GET: RequestHandler = async (event) => {
	requirePerm(event, 'deploy.view');
	const rt = getRuntime();
	const app = rt.deploys.getApp(event.params.id);
	if (!app) return apiError(404, 'app not found');
	const checks = await domainCheck(rt, app);
	return apiJson({ checks });
};
