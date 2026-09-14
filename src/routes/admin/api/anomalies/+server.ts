import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiJson, requirePerm } from '$lib/server/admin/http';
import {
	ANOMALY_LIST_MAX,
	ANOMALY_SEVERITIES,
	getEngine,
	type AnomalySeverity
} from '$lib/server/anomaly/engine';

export const GET: RequestHandler = (event) => {
	requirePerm(event, 'anomaly.view');
	const rt = getRuntime();
	const url = event.url;
	const sev = url.searchParams.get('severity');
	const severity = (ANOMALY_SEVERITIES as readonly string[]).includes(sev ?? '')
		? (sev as AnomalySeverity)
		: undefined;
	const status = url.searchParams.get('status');
	const since = Number(url.searchParams.get('since'));
	const cursor = Number(url.searchParams.get('cursor'));
	const limit = Math.min(
		Math.max(Math.floor(Number(url.searchParams.get('limit') ?? 100) || 100), 1),
		ANOMALY_LIST_MAX
	);
	const engine = getEngine(rt.db);
	const { entries, nextCursor } = engine.list({
		status: status === 'open' || status === 'acked' ? status : undefined,
		since: Number.isFinite(since) && since > 0 ? since : undefined,
		severity,
		metric: url.searchParams.get('metric')?.slice(0, 128) ?? undefined,
		limit,
		cursor: Number.isFinite(cursor) && cursor > 0 ? cursor : undefined
	});
	return apiJson({ entries, nextCursor, summary: engine.summary() });
};
