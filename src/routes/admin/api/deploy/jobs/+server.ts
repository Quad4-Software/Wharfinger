import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiJson, requirePerm } from '$lib/server/admin/http';
import { JOB_STATUSES } from '$lib/shared/jobs';
import type { JobStatus } from '$lib/shared/jobs';

/** Queue view: recent jobs with status, newest first. */
export const GET: RequestHandler = async (event) => {
	requirePerm(event, 'deploy.view');
	const rt = getRuntime();
	const raw = event.url.searchParams.get('status');
	const status = (JOB_STATUSES as readonly string[]).includes(raw ?? '')
		? (raw as JobStatus)
		: null;
	return apiJson({
		jobs: (await rt.jobs.list({ status: status ?? undefined, limit: 100 })).map((j) => ({
			...j,
			spec: undefined,
			result: j.result ? (JSON.parse(j.result) as unknown) : null
		}))
	});
};
