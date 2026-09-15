import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiJson, requirePerm } from '$lib/server/admin/http';
import { JOB_STATUSES } from '$lib/shared/jobs';
import type { Job, JobStatus } from '$lib/shared/jobs';

/**
 * Queue view: recent jobs with status, newest first. Queued jobs get
 * a waitingReason so the panel can show why a job has not started:
 * scheduled for later, or the target agent is offline or revoked.
 */
export const GET: RequestHandler = async (event) => {
	requirePerm(event, 'deploy.view');
	const rt = getRuntime();
	const raw = event.url.searchParams.get('status');
	const status = (JOB_STATUSES as readonly string[]).includes(raw ?? '')
		? (raw as JobStatus)
		: null;
	const jobs = await rt.jobs.list({ status: status ?? undefined, limit: 100 });

	const now = Date.now();
	let agentState: Map<string, 'online' | 'offline' | 'revoked'> | null = null;
	if (jobs.some((j) => j.status === 'queued' && j.target)) {
		const windowMs = rt.config.ingress.online_seconds * 1000;
		agentState = new Map(
			(await rt.agents.list()).map((a) => [
				a.id,
				a.revokedAt !== null
					? 'revoked'
					: a.lastSeenAt !== null && now - a.lastSeenAt < windowMs
						? 'online'
						: 'offline'
			])
		);
	}

	const waitingReason = (j: Job): string | null => {
		if (j.status !== 'queued') return null;
		if (j.notBefore !== null && j.notBefore > now) return 'scheduled';
		if (!j.target) return null;
		const s = agentState?.get(j.target);
		if (s === 'revoked') return 'agent revoked';
		if (!s || s === 'offline') return 'agent offline';
		return null;
	};

	return apiJson({
		jobs: jobs.map((j) => ({
			...j,
			spec: undefined,
			result: j.result ? (JSON.parse(j.result) as unknown) : null,
			waitingReason: waitingReason(j)
		}))
	});
};
