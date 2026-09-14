import type { AgentRow } from './agents';
import type { AgentPayload } from './schema';
import type { AgentView } from '$lib/shared/agents';

export type { AgentView } from '$lib/shared/agents';

/**
 * Shape an agent row for the panel: online status relative to the
 * configured window plus a small summary extracted from the last full
 * payload (which can be large).
 */
export function agentView(
	row: AgentRow & { lastPayload?: unknown },
	onlineWindowMs: number
): AgentView {
	const online = row.lastSeenAt !== null && Date.now() - row.lastSeenAt < onlineWindowMs;
	let summary: AgentView['summary'] = null;
	const p = row.lastPayload as AgentPayload | null | undefined;
	if (p && typeof p === 'object') {
		summary = {
			cpuPct: p.cpu.pct,
			memPct: p.mem.pct,
			diskPct: p.disks?.length ? Math.max(...p.disks.map((d) => d.pct)) : null,
			rxBps: p.net.rxBps,
			txBps: p.net.txBps,
			load1: p.cpu.load1,
			cores: p.cpu.cores,
			uptimeSec: p.agent.uptimeSec,
			tempMax: p.temps?.length ? Math.max(...p.temps.map((t) => t.celsius)) : null,
			containers: p.docker ? { running: p.docker.running, total: p.docker.total } : null,
			servicesFailed: p.services
				? p.services.filter((s) => s.manager === 'systemd' && s.state === 'failed').length
				: null
		};
	}
	return {
		id: row.id,
		name: row.name,
		fingerprintBound: row.fingerprint !== null,
		keyBound: row.pubkey !== null,
		createdAt: row.createdAt,
		createdBy: row.createdBy,
		lastSeenAt: row.lastSeenAt,
		online,
		revoked: row.revokedAt !== null,
		alerts: Object.keys(row.alerts),
		meta: row.meta,
		summary
	};
}
