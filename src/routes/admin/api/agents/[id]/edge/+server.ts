import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, requirePerm } from '$lib/server/admin/http';

const RANGES: Record<string, number> = {
	'1h': 3600_000,
	'6h': 6 * 3600_000,
	'24h': 24 * 3600_000,
	'7d': 7 * 24 * 3600_000
};

// Edge traffic series plus the latest full report (top clients,
// paths, recent errors) for the system detail page.
export const GET: RequestHandler = (event) => {
	requirePerm(event, 'agents.manage');
	const rt = getRuntime();
	const agent = rt.agents.get(event.params.id);
	if (!agent) return apiError(404, 'agent not found');
	const range = event.url.searchParams.get('range') ?? '1h';
	const ms = RANGES[range] ?? RANGES['1h'];
	return apiJson({
		range,
		samples: rt.edge.history(agent.id, Date.now() - ms),
		latest: rt.edge.latest(agent.id)
	});
};
