import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, readText } from '$lib/server/admin/http';
import { bearerToken, gate, proofGate } from '$lib/server/ingress/http';
import { settleDeployJob } from '$lib/server/deploy/trigger';
import { markScanJobRunning, settleScanJob } from '$lib/server/scan/trigger';

const ACTIONS = ['start', 'heartbeat', 'progress', 'succeed', 'fail', 'rolled_back'] as const;
type Action = (typeof ACTIONS)[number];
const MAX_CHUNK = 64 * 1024;

/**
 * Per-job lifecycle endpoint. Every call must carry the lease token
 * issued at claim time; the queue rejects transitions from anyone
 * else, so a guessed job id is useless without the lease. The proof
 * signature covers the raw body, so it is verified before parsing.
 */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const g = gate(rt, rt.agents, bearerToken(event.request));
	if (g.err) return g.err;

	const jobId = Number(event.params.id);
	if (!Number.isInteger(jobId) || jobId <= 0) return apiError(404, 'not found');

	const text = await readText(event.request, 128 * 1024);
	const badProof = proofGate(rt, g.agent, event.request, Buffer.from(text, 'utf8'));
	if (badProof) return badProof;

	let body: { lease?: unknown; action?: unknown; chunk?: unknown; result?: unknown };
	try {
		body = JSON.parse(text) as typeof body;
	} catch {
		return apiError(400, 'expected a JSON body');
	}

	const lease = typeof body.lease === 'string' ? body.lease : '';
	const action = body.action as Action;
	if (!lease || !ACTIONS.includes(action))
		return apiError(422, 'expected lease and a valid action');

	switch (action) {
		case 'start': {
			const ok = rt.jobs.start(jobId, lease);
			if (ok) markScanJobRunning(rt, jobId);
			return apiJson({ ok });
		}
		case 'heartbeat':
			return apiJson({ ok: rt.jobs.heartbeat(jobId, lease) });
		case 'progress': {
			const chunk = typeof body.chunk === 'string' ? body.chunk.slice(0, MAX_CHUNK) : '';
			return apiJson({ ok: rt.jobs.progress(jobId, lease, chunk) });
		}
		case 'succeed': {
			const ok = rt.jobs.succeed(jobId, lease, body.result);
			if (ok) {
				settleDeployJob(rt, jobId);
				settleScanJob(rt, jobId);
			}
			return apiJson({ ok });
		}
		case 'fail': {
			const r = rt.jobs.fail(jobId, lease, body.result);
			if (r.status === 'failed') {
				settleDeployJob(rt, jobId);
				settleScanJob(rt, jobId);
			}
			return apiJson(r);
		}
		case 'rolled_back': {
			const r = rt.jobs.fail(jobId, lease, body.result, { rolledBack: true });
			if (r.status === 'rolled_back') {
				settleDeployJob(rt, jobId);
				settleScanJob(rt, jobId);
			}
			return apiJson(r);
		}
	}
};
