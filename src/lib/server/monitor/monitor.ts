import { EventEmitter } from 'node:events';
import type { StatusConfig, ServiceConfig } from '$lib/server/config/schema';
import type { CheckStore } from '$lib/server/store/checks';
import type { IncidentStore } from '$lib/server/store/incidents';
import type { PushStore } from '$lib/server/store/push';
import type { ServiceStatus } from '$lib/shared/status';
import type { Egress } from '$lib/server/http/egress';
import { runCheck } from './checkers';
import { ServiceState } from './service-state';

/**
 * Emits 'update' after every recorded check, 'change' when a service
 * status actually transitions, and 'transition' with
 * { service, prev, next } for listeners that need the detail
 * (notification dispatch). Listeners (SSE hub, snapshot cache) key off
 * these.
 */
export class Monitor extends EventEmitter {
	private states = new Map<string, ServiceState>();
	private timers = new Map<string, NodeJS.Timeout>();
	private inFlight = 0;
	private queue: (() => void)[] = [];
	private stopped = false;
	private pruneTimer: NodeJS.Timeout | null = null;
	readonly userAgent: string;

	readonly serviceStatus = new Map<string, ServiceStatus>();
	/** Days until TLS cert expiry per service, null when not monitored. */
	readonly certDays = new Map<string, number | null>();

	constructor(
		private config: StatusConfig,
		private checks: CheckStore,
		private incidents: IncidentStore,
		private egress: Egress,
		private pushBeats?: PushStore
	) {
		super();
		this.setMaxListeners(0);
		this.userAgent =
			config.monitor.user_agent ??
			`${config.site.name} status (+${config.site.url ?? 'https://localhost'})`;
		for (const s of config.services) {
			this.states.set(
				s.id,
				new ServiceState(config.monitor.failure_threshold, config.monitor.recovery_threshold)
			);
			this.serviceStatus.set(s.id, 'unknown');
			this.certDays.set(s.id, null);
		}
	}

	start(): void {
		this.stopped = false;
		for (const s of this.config.services) this.schedule(s, this.jitteredDelay(s));
		this.pruneTimer = setInterval(() => {
			this.prune();
		}, 3600_000);
		this.pruneTimer.unref();
		this.prune();
	}

	stop(): void {
		this.stopped = true;
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
		if (this.pruneTimer) clearInterval(this.pruneTimer);
		this.queue.length = 0;
	}

	reload(config: StatusConfig): void {
		this.stop();
		this.config = config;
		// Carry state forward for services that still exist so a config
		// edit does not re-fire transitions (and notifications) for
		// services whose status has not actually changed.
		for (const id of [...this.states.keys()]) {
			if (!config.services.some((s) => s.id === id)) {
				this.states.delete(id);
				this.serviceStatus.delete(id);
				this.certDays.delete(id);
			}
		}
		for (const s of config.services) {
			if (!this.states.has(s.id)) {
				this.states.set(
					s.id,
					new ServiceState(config.monitor.failure_threshold, config.monitor.recovery_threshold)
				);
				this.serviceStatus.set(s.id, 'unknown');
				this.certDays.set(s.id, null);
			}
		}
		this.emit('change');
		this.start();
	}

	private jitteredDelay(s: ServiceConfig): number {
		// Stagger the first run of each service over the first interval so a
		// boot does not fire every check at once.
		return Math.floor(Math.random() * Math.min(this.intervalMs(s), 5000));
	}

	private intervalMs(s: ServiceConfig): number {
		return (s.interval_seconds ?? this.config.monitor.default_interval_seconds) * 1000;
	}

	private schedule(s: ServiceConfig, delay: number): void {
		if (this.stopped) return;
		const timer = setTimeout(() => {
			void this.runOne(s).finally(() => {
				this.schedule(s, this.intervalMs(s));
			});
		}, delay);
		timer.unref();
		this.timers.set(s.id, timer);
	}

	private async acquire(): Promise<void> {
		if (this.inFlight < this.config.monitor.concurrency) {
			this.inFlight += 1;
			return;
		}
		await new Promise<void>((res) => this.queue.push(res));
		this.inFlight += 1;
	}

	private release(): void {
		this.inFlight -= 1;
		const next = this.queue.shift();
		if (next) next();
	}

	private async runOne(s: ServiceConfig): Promise<void> {
		await this.acquire();
		try {
			const ctx = {
				timeoutMs: s.timeout_ms ?? this.config.monitor.default_timeout_ms,
				degradedMs: s.degraded_ms ?? this.config.monitor.default_degraded_ms,
				userAgent: this.userAgent,
				certWarnDays: this.config.monitor.cert_warn_days,
				egress: this.egress,
				lastBeat: (id: string) => this.pushBeats?.lastBeat(id) ?? null
			};
			const outcome = await runCheck(s, ctx);
			const status: 'up' | 'down' | 'degraded' = outcome.ok
				? outcome.degraded
					? 'degraded'
					: 'up'
				: 'down';
			this.checks.record(s.id, {
				ok: outcome.ok,
				latencyMs: outcome.latencyMs,
				status,
				detail: outcome.detail
			});
			if (outcome.certDays !== undefined) this.certDays.set(s.id, outcome.certDays);

			const state = this.states.get(s.id);
			const next = state?.apply(outcome);
			if (next) this.onTransition(s, next);
			this.emit('update');
		} catch (err) {
			console.error(`[monitor] check ${s.id} crashed:`, err);
		} finally {
			this.release();
		}
	}

	private onTransition(s: ServiceConfig, next: ServiceStatus): void {
		const prev = this.serviceStatus.get(s.id);
		this.serviceStatus.set(s.id, next);

		const wasDown = prev === 'major_outage' || prev === 'partial_outage' || prev === 'degraded';
		const isDown = next === 'major_outage' || next === 'partial_outage' || next === 'degraded';
		if (!wasDown && isDown) {
			this.incidents.open(
				s.id,
				next === 'degraded' ? 'minor' : 'major',
				`${s.name} is ${next === 'degraded' ? 'degraded' : 'down'}`
			);
		} else if (wasDown && !isDown) {
			this.incidents.close(s.id);
		}
		this.emit('transition', { service: s, prev: prev ?? 'unknown', next });
		this.emit('change');
	}

	private prune(): void {
		const cutoff = Date.now() - this.config.monitor.retention_days * 86_400_000;
		try {
			const n = this.checks.prune(cutoff);
			if (n > 0) console.log(`[monitor] pruned ${n} check rows`);
			this.checks.pruneIncidents(cutoff);
		} catch (err) {
			console.error('[monitor] prune failed:', err);
		}
	}
}
