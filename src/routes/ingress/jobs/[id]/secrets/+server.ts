import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, readText } from '$lib/server/admin/http';
import { bearerToken, gate, proofGate } from '$lib/server/ingress/http';
import type { DeploySpec } from '$lib/shared/deploy';

/**
 * Secret delivery for a claimed deploy job. Env values and the
 * deploy private key never sit in the job row; the lease-holding
 * agent fetches them here over the encrypted, proof-signed channel.
 * Requires the live lease, so the material is unreachable once the
 * job finishes or the lease expires.
 */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const g = gate(rt, rt.agents, bearerToken(event.request));
	if (g.err) return g.err;

	const jobId = Number(event.params.id);
	if (!Number.isInteger(jobId) || jobId <= 0) return apiError(404, 'not found');

	const text = await readText(event.request, 8192);
	const badProof = proofGate(rt, g.agent, event.request, Buffer.from(text, 'utf8'));
	if (badProof) return badProof;

	let body: { lease?: unknown };
	try {
		body = JSON.parse(text) as typeof body;
	} catch {
		return apiError(400, 'expected a JSON body');
	}
	const lease = typeof body.lease === 'string' ? body.lease : '';
	if (!lease) return apiError(422, 'expected lease');

	const job = rt.jobs.get(jobId);
	if (
		job?.kind !== 'deploy' ||
		job.leaseOwner !== lease ||
		(job.status !== 'claimed' && job.status !== 'running') ||
		(job.target ?? g.agent.id) !== g.agent.id
	) {
		return apiError(403, 'no live lease for this job');
	}

	let spec: DeploySpec;
	try {
		spec = JSON.parse(job.spec) as DeploySpec;
	} catch {
		return apiError(500, 'corrupt job spec');
	}

	const key = rt.deploys.deployKeyFor(spec.appId);
	return apiJson({
		ok: true,
		env: rt.deploys.envFor(spec.appId),
		deployKey: key ? { priv: key.priv.toString('base64'), pub: key.pub } : null
	});
};
