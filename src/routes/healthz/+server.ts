import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';

export const GET: RequestHandler = () => {
	const rt = getRuntime();
	return Response.json(
		{
			ok: true,
			services: rt.monitor.serviceStatus.size,
			uptimeSec: Math.round(process.uptime())
		},
		{ headers: { 'cache-control': 'no-store' } }
	);
};
