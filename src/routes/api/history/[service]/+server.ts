import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { buildLatencySeries, LATENCY_RANGES, type LatencyRange } from '$lib/shared/uptime';

export const GET: RequestHandler = async ({ params, url }) => {
	const rt = getRuntime();
	const id = params.service;
	if (!rt.config.services.some((s) => s.id === id)) {
		return Response.json({ error: 'unknown service' }, { status: 404 });
	}

	const raw = url.searchParams.get('range') ?? '24h';
	const range: LatencyRange = raw in LATENCY_RANGES ? (raw as LatencyRange) : '24h';
	const spec = LATENCY_RANGES[range];
	const now = Date.now();
	const start = now - spec.ms;

	const rows = await rt.checks.since(id, start);
	const series = buildLatencySeries({ checks: rows, start, end: now, buckets: spec.buckets });
	const frac = await rt.checks.uptimeFraction(id, start);

	return Response.json(
		{
			service: id,
			range,
			uptime: frac === null ? null : Math.round(frac * 10000) / 100,
			series,
			markers: (await rt.markers.between(start, now, id)).map((m) => ({
				ts: m.ts,
				title: m.title,
				kind: m.kind
			}))
		},
		{ headers: { 'cache-control': 'public, max-age=60, stale-while-revalidate=120' } }
	);
};
