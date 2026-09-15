import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, requirePerm } from '$lib/server/admin/http';

const RANGES: Record<string, number> = {
	'15m': 15 * 60_000,
	'1h': 3600_000,
	'6h': 6 * 3600_000,
	'24h': 24 * 3600_000,
	'7d': 7 * 24 * 3600_000,
	'30d': 30 * 24 * 3600_000
};

// Downsampled metric history for graphs. Samples are stored at the
// agent's own interval; range selection is a simple ts cutoff.
export const GET: RequestHandler = async (event) => {
	requirePerm(event, 'agents.manage');
	const rt = getRuntime();
	const agent = await rt.agents.get(event.params.id);
	if (!agent) return apiError(404, 'agent not found');
	const range = event.url.searchParams.get('range') ?? '1h';
	const ms = RANGES[range] ?? RANGES['1h'];
	return apiJson({
		range,
		samples: await rt.agents.history(agent.id, Date.now() - ms)
	});
};
