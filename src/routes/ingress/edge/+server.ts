import * as v from 'valibot';
import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, readJson } from '$lib/server/admin/http';
import { bearerToken, gate } from '$lib/server/ingress/http';
import { EdgeReport } from '$lib/server/ingress/schema';

// Edge reports arrive on the reporter's clock; keep the same skew
// discipline as metrics so the series index stays sane.
const MAX_SKEW_MS = 3600_000;

/** Edge traffic ingest (traefik plugin). Bearer token in Authorization. */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const g = await gate(rt, rt.agents, bearerToken(event.request));
	if (g.err) return g.err;

	const body = await readJson(event.request, rt.config.ingress.max_body_kb * 1024);
	const parsed = v.safeParse(EdgeReport, body);
	if (!parsed.success) {
		return apiError(422, 'invalid report', {
			issues: parsed.issues.slice(0, 5).map((i) => i.message)
		});
	}
	const r = parsed.output;
	if (Math.abs(r.ts - Date.now()) > MAX_SKEW_MS) {
		return apiError(422, 'report timestamp out of accepted window');
	}
	await rt.edge.record(g.agent.id, r);
	// A reporting edge proves the registration is alive.
	await rt.agents.touch(g.agent.id);
	return apiJson({ ok: true });
};
