import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, readText } from '$lib/server/admin/http';
import { bearerToken, gate, proofGate } from '$lib/server/ingress/http';
import { settleDeployJob } from '$lib/server/deploy/trigger';
import { settleScanJob } from '$lib/server/scan/trigger';

const OUTCOMES = ['succeeded', 'failed', 'rolled_back'] as const;

interface ReconcileItem {
	id?: unknown;
	outcome?: unknown;
	result?: unknown;
}

/**
 * Executor restart report. After a crash or reboot the agent posts
 * the outcomes it journaled locally for jobs the hub marked
 * 'unknown'. Only transitions out of 'unknown' are applied; a live
 * job can never be force-closed by a stale report.
 */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const g = gate(rt, rt.agents, bearerToken(event.request));
	if (g.err) return g.err;

	const text = await readText(event.request, 64 * 1024);
	const badProof = proofGate(rt, g.agent, event.request, Buffer.from(text, 'utf8'));
	if (badProof) return badProof;

	let body: { jobs?: unknown };
	try {
		body = JSON.parse(text) as typeof body;
	} catch {
		return apiError(400, 'expected a JSON body');
	}

	const items = Array.isArray(body.jobs) ? (body.jobs as ReconcileItem[]).slice(0, 100) : [];
	let applied = 0;
	for (const item of items) {
		const id = Number(item.id);
		const outcome = item.outcome as (typeof OUTCOMES)[number];
		if (!Number.isInteger(id) || id <= 0 || !OUTCOMES.includes(outcome)) continue;
		const job = rt.jobs.get(id);
		// An agent may only reconcile jobs that were targeted at it.
		if (!job || (job.target !== null && job.target !== g.agent.id)) continue;
		if (rt.jobs.reconcile(id, outcome, item.result)) {
			applied++;
			// Close out linked records too: a reconciled deploy release
			// or scan report must not stay pending/running forever.
			settleDeployJob(rt, id);
			settleScanJob(rt, id);
		}
	}
	return apiJson({ ok: true, applied });
};
