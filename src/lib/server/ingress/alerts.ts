import type { StatusConfig } from '$lib/server/config/schema';
import type { NotifyDispatcher } from '$lib/server/notify/dispatcher';
import type { AgentPayload } from './schema';
import type { AgentRow, AgentStore } from './agents';

// Points below the configured threshold where a firing rule clears
// again. Keeps a metric hovering at the boundary from flapping
// notifications every sample.
const HYSTERESIS = 10;

type ThresholdRule = 'cpu' | 'mem' | 'disk';

const RULE_LABEL: Record<ThresholdRule | 'offline', string> = {
	offline: 'agent',
	cpu: 'CPU',
	mem: 'memory',
	disk: 'disk'
};

interface AlertSubject {
	id: string;
	name: string;
	alerts: Record<string, number>;
}

/**
 * Turns agent health signals into notify events. Threshold rules are
 * evaluated on each ingested sample; silence is detected by tick() on
 * a timer since an offline agent cannot report its own death. Active
 * alerts persist on the agent row so a hub restart does not re-fire.
 * Events reuse down/degraded/recovered so existing targets pick them
 * up without config changes.
 */
export class AgentAlerter {
	constructor(
		private readonly config: () => StatusConfig,
		private readonly agents: AgentStore,
		private readonly dispatcher: NotifyDispatcher
	) {}

	/** Evaluate threshold rules against a fresh, already-recorded sample. */
	onSample(agent: AgentRow, p: AgentPayload): void {
		const ing = this.config().ingress;
		const alerts = { ...agent.alerts };
		let dirty = false;

		// Reporting again after silence is a recovery.
		if ('offline' in alerts) {
			delete alerts.offline;
			dirty = true;
			this.fire(agent, 'recovered', 'agent reporting again');
		}

		const thresholds: [ThresholdRule, number, number][] = [
			['cpu', ing.alert_cpu_pct, p.cpu.pct],
			['mem', ing.alert_mem_pct, p.mem.pct],
			['disk', ing.alert_disk_pct, p.disks?.length ? Math.max(...p.disks.map((d) => d.pct)) : 0]
		];
		for (const [rule, threshold, value] of thresholds) {
			if (threshold <= 0) {
				// Rule switched off while firing: clear silently.
				if (rule in alerts) {
					Reflect.deleteProperty(alerts, rule);
					dirty = true;
				}
				continue;
			}
			const firing = rule in alerts;
			if (!firing && value >= threshold) {
				alerts[rule] = Date.now();
				dirty = true;
				this.fire(
					agent,
					'degraded',
					`${RULE_LABEL[rule]} at ${value.toFixed(1)}% (threshold ${threshold}%)`
				);
			} else if (firing && value < threshold - HYSTERESIS) {
				Reflect.deleteProperty(alerts, rule);
				dirty = true;
				this.fire(
					agent,
					'recovered',
					`${RULE_LABEL[rule]} back to ${value.toFixed(1)}% (threshold ${threshold}%)`
				);
			}
		}
		if (dirty) this.agents.setAlerts(agent.id, alerts);
	}

	/** Periodic silence detector; run on a ~1min timer from the runtime. */
	tick(): void {
		const offMin = this.config().ingress.alert_offline_minutes;
		const now = Date.now();
		for (const agent of this.agents.scan()) {
			const alerts = { ...agent.alerts };
			if (offMin <= 0) {
				if ('offline' in alerts) {
					delete alerts.offline;
					this.agents.setAlerts(agent.id, alerts);
				}
				continue;
			}
			if (agent.lastSeenAt === null || 'offline' in alerts) continue;
			const silentMs = now - agent.lastSeenAt;
			if (silentMs <= offMin * 60_000) continue;
			alerts.offline = now;
			this.agents.setAlerts(agent.id, alerts);
			this.fire(agent, 'down', `no metrics for ${Math.round(silentMs / 60_000)} min`);
		}
	}

	private fire(
		agent: AlertSubject,
		event: 'down' | 'degraded' | 'recovered',
		detail: string
	): void {
		void this.dispatcher.notify({
			event,
			serviceId: `agent:${agent.id}`,
			serviceName: agent.name,
			detail
		});
	}
}
