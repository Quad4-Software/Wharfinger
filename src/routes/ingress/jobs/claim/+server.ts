import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, readText } from '$lib/server/admin/http';
import { bearerToken, gate, proofGate } from '$lib/server/ingress/http';
import { JOB_KINDS, type JobKind } from '$lib/shared/jobs';

/**
 * Agent work claim. Pull model: the agent asks for its next job and
 * the queue hands it out with a random lease token atomically. The
 * response carries the frozen spec; only the lease holder can make
 * further calls on the job.
 */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const g = await gate(rt, rt.agents, bearerToken(event.request));
	if (g.err) return g.err;

	const text = await readText(event.request, 8192);
	const badProof = await proofGate(rt, g.agent, event.request, Buffer.from(text, 'utf8'));
	if (badProof) return badProof;

	let kinds: JobKind[] = [...JOB_KINDS];
	if (text.trim()) {
		let body: { kinds?: unknown };
		try {
			body = JSON.parse(text) as typeof body;
		} catch {
			return apiError(400, 'expected a JSON body');
		}
		if (Array.isArray(body.kinds)) {
			kinds = body.kinds.filter((k): k is JobKind =>
				(JOB_KINDS as readonly string[]).includes(String(k))
			);
		}
	}

	for (const kind of kinds) {
		const job = await rt.jobs.claim(kind, g.agent.id);
		if (job) return apiJson({ ok: true, job });
	}
	return apiJson({ ok: true, job: null });
};
