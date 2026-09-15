import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { apiError, apiJson, audit, readJson, requirePerm } from '$lib/server/admin/http';
import { AGENT_TASK_ACTIONS, type AgentTaskAction, type AgentTaskSpec } from '$lib/shared/jobs';

// Unit names: letters, digits, and the usual unit-name punctuation.
// No slashes or whitespace, so the value is always one argv element.
const UNIT_RE = /^[a-zA-Z0-9@:._-]{1,128}$/;
// Scheduled tasks at most a week out; further scheduling belongs in
// a calendar, not the job queue.
const MAX_SCHEDULE_AHEAD_MS = 7 * 24 * 3600_000;
// A reboot mutes the offline alert for this long; the agent should
// be back well inside it, and a host that stays down still pages.
const REBOOT_MUTE_MS = 30 * 60_000;

/**
 * Queue an operator task on an agent: service control, package
 * refresh/apply, or a scheduled reboot. `at` (epoch ms) schedules
 * the job for later via the queue's not_before; reboots also mute
 * the offline alert for the drain window.
 */
export const POST: RequestHandler = async (event) => {
	requirePerm(event, 'agents.manage');
	const rt = getRuntime();
	const agent = await rt.agents.get(event.params.id);
	if (!agent) return apiError(404, 'agent not found');
	if (agent.revokedAt) return apiError(409, 'agent is revoked');

	const body = await readJson<{
		action?: unknown;
		unit?: unknown;
		securityOnly?: unknown;
		at?: unknown;
	}>(event.request, 8192);
	const action = typeof body.action === 'string' ? body.action : '';
	if (!(AGENT_TASK_ACTIONS as readonly string[]).includes(action)) {
		return apiError(422, `action must be one of ${AGENT_TASK_ACTIONS.join(', ')}`);
	}
	const spec: AgentTaskSpec = { action: action as AgentTaskAction };
	if (action.startsWith('service.')) {
		const unit = typeof body.unit === 'string' ? body.unit.trim() : '';
		if (!UNIT_RE.test(unit)) return apiError(422, 'unit must be a unit name, not a path or text');
		spec.unit = unit;
	} else {
		if (body.unit !== undefined && body.unit !== null && body.unit !== '') {
			return apiError(422, 'unit only applies to service actions');
		}
		if (action === 'packages.apply' && body.securityOnly === true) {
			spec.securityOnly = true;
		}
	}

	let notBefore: number | undefined;
	if (body.at !== undefined && body.at !== null) {
		const at = Number(body.at);
		if (!Number.isFinite(at) || at < Date.now() || at > Date.now() + MAX_SCHEDULE_AHEAD_MS) {
			return apiError(422, 'at must be a time within the next 7 days');
		}
		notBefore = Math.floor(at);
	}

	const { job } = await rt.jobs.enqueue({
		kind: 'agent-task',
		target: agent.id,
		spec,
		notBefore
	});
	if (spec.action === 'host.reboot') {
		// Mute from the scheduled time (or now) through the drain
		// window so the expected silence does not page.
		const base = notBefore ?? Date.now();
		await rt.agents.setMutedUntil(agent.id, base + REBOOT_MUTE_MS);
	}
	await audit(
		rt,
		event,
		'agents.task',
		`id=${agent.id} action=${spec.action}${spec.unit ? ` unit=${spec.unit}` : ''}${notBefore ? ` at=${new Date(notBefore).toISOString()}` : ''}`
	);
	return apiJson({ ok: true, jobId: job.id, queued: true });
};
