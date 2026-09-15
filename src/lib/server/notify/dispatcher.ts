import type {
	NotifyEvent,
	NotifyTargetConfig,
	ServiceConfig,
	StatusConfig
} from '$lib/server/config/schema';
import type { Monitor } from '$lib/server/monitor/monitor';
import type { ServiceStatus } from '$lib/shared/status';
import { expandWindows } from '$lib/server/status/snapshot';
import type { NotificationLog } from './log';
import type { Egress, FetchInit } from '$lib/server/http/egress';
import type { SubscriberStore } from '$lib/server/store/subscribers';
import { renderMessage, type NotifyContext } from './templates';
import { sendToTarget } from './senders';

interface Transition {
	service: ServiceConfig;
	prev: ServiceStatus;
	next: ServiceStatus;
}

const DOWN_STATES: ServiceStatus[] = ['major_outage', 'partial_outage'];
const BAD_STATES: ServiceStatus[] = [...DOWN_STATES, 'degraded'];

function eventFor(t: Transition): NotifyEvent | null {
	// Boot and reload produce unknown -> X transitions; only alert when
	// the first observation is already bad.
	if (t.prev === t.next) return null;
	if (t.prev === 'unknown') {
		if (DOWN_STATES.includes(t.next)) return 'down';
		if (t.next === 'degraded') return 'degraded';
		return null;
	}
	if (DOWN_STATES.includes(t.next) && !DOWN_STATES.includes(t.prev)) return 'down';
	if (t.next === 'degraded' && t.prev !== 'degraded') return 'degraded';
	if (BAD_STATES.includes(t.prev) && !BAD_STATES.includes(t.next)) return 'recovered';
	return null;
}

/**
 * Fans monitor transitions and admin events out to configured targets
 * (ntfy, UnifiedPush, webhooks). Applies per-target event/service
 * filters, a (target, service, event) cooldown, bounded retries, and
 * writes every attempt to the notification log.
 */
export class NotifyDispatcher {
	private lastSent = new Map<string, number>();
	private activeWindows = new Set<string>();
	private maintTimer: NodeJS.Timeout | null = null;
	// Transition handling is async once the log and subscriber stores
	// became async; queueing each notify keeps ordering deterministic.
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly config: () => StatusConfig,
		private readonly log: NotificationLog,
		private readonly egress: Egress,
		private readonly subscribers?: SubscriberStore
	) {}

	private enqueue(p: Promise<void>): void {
		this.queue = this.queue
			.then(() => p)
			.catch((err: unknown) => {
				console.warn('[notify] dispatch failed:', err);
			});
	}

	attach(monitor: Monitor): void {
		monitor.on('transition', (t: Transition) => {
			const event = eventFor(t);
			if (!event) return;
			// A service inside an active maintenance window is expected
			// to flap; suppress its down/degraded alerts entirely.
			if ((event === 'down' || event === 'degraded') && this.inMaintenance(t.service.id)) {
				return;
			}
			this.enqueue(
				this.notify({
					event,
					serviceId: t.service.id,
					serviceName: t.service.name,
					status: t.next,
					detail: null
				})
			);
		});
		this.maintTimer = setInterval(() => {
			this.checkMaintenance();
		}, 60_000);
		this.maintTimer.unref();
	}

	stop(): void {
		if (this.maintTimer) clearInterval(this.maintTimer);
		this.maintTimer = null;
	}

	/** Is the service covered by a maintenance window active right now? */
	private inMaintenance(serviceId: string): boolean {
		const now = Date.now();
		return expandWindows(this.config(), now, 0, 0).some(
			(w) =>
				w.start <= now &&
				w.end >= now &&
				(w.services.includes('all') || w.services.includes(serviceId))
		);
	}

	/** Fire a 'maintenance' event the first time a window goes active. */
	private checkMaintenance(): void {
		// Cooldown keys are only meaningful for one cooldown window;
		// without this sweep the map grows with every agent and event.
		const cutoff = Date.now() - this.config().notifications.cooldown_seconds * 1000;
		for (const [k, t] of this.lastSent) {
			if (t < cutoff) this.lastSent.delete(k);
		}
		const cfg = this.config();
		if (!cfg.notifications.enabled) return;
		const now = Date.now();
		const active = new Set(
			expandWindows(cfg, now, 0, 0)
				.filter((w) => w.start <= now && w.end >= now)
				.map((w) => `${w.title}|${w.start}`)
		);
		for (const key of active) {
			if (this.activeWindows.has(key)) continue;
			const title = key.slice(0, key.lastIndexOf('|'));
			this.enqueue(this.notify({ event: 'maintenance', serviceName: `Maintenance: ${title}` }));
		}
		this.activeWindows = active;
	}

	private coolingDown(target: string, serviceId: string | null, event: string): boolean {
		const cooldownMs = this.config().notifications.cooldown_seconds * 1000;
		if (cooldownMs <= 0) return false;
		const key = `${target}|${serviceId ?? ''}|${event}`;
		const last = this.lastSent.get(key);
		if (last === undefined || Date.now() - last >= cooldownMs) {
			this.lastSent.set(key, Date.now());
			return false;
		}
		return true;
	}

	private matches(
		target: NotifyTargetConfig,
		ctx: Omit<NotifyContext, 'siteName' | 'siteUrl'>
	): boolean {
		if (!target.enabled) return false;
		if (ctx.event !== 'test' && !target.events.includes(ctx.event)) return false;
		if (
			ctx.serviceId &&
			!target.services.includes('all') &&
			!target.services.includes(ctx.serviceId)
		) {
			return false;
		}
		return true;
	}

	/**
	 * Dispatch an event to every matching target. Test events bypass the
	 * cooldown so the panel test button always produces a result.
	 */
	async notify(ctx: Omit<NotifyContext, 'siteName' | 'siteUrl'>): Promise<void> {
		const cfg = this.config();
		if (!cfg.notifications.enabled && ctx.event !== 'test') return;
		const siteName = cfg.site.name;
		const siteUrl = cfg.site.url ?? null;

		const jobs = cfg.notifications.targets
			.filter((t) => this.matches(t, ctx))
			.filter(
				(t) => ctx.event === 'test' || !this.coolingDown(t.name, ctx.serviceId ?? null, ctx.event)
			)
			.map(async (target) => {
				const msg = renderMessage({ ...ctx, siteName, siteUrl });
				const result = await this.sendWithRetry(target, msg, cfg.notifications);
				await this.log.record({
					target: target.name,
					kind: target.type,
					event: ctx.event,
					serviceId: ctx.serviceId ?? null,
					ok: result.ok,
					status: result.status,
					error: result.error
				});
			});
		await Promise.allSettled(jobs);
		await this.fanOutSubscribers(ctx, siteName);
	}

	/** Public webhook subscribers get the same transitions, HMAC-signed. */
	private async fanOutSubscribers(
		ctx: Omit<NotifyContext, 'siteName' | 'siteUrl'>,
		site: string
	): Promise<void> {
		if (!this.subscribers || ctx.event === 'test') return;
		const origin = this.config().site.url;
		for (const sub of await this.subscribers.active(ctx.serviceId ?? null)) {
			const payload = JSON.stringify({
				type: 'status.event',
				site,
				event: ctx.event,
				service_id: ctx.serviceId ?? null,
				service_name: ctx.serviceName ?? null,
				status: ctx.status ?? null,
				at: Date.now(),
				unsubscribe_url: origin
					? `${origin}/api/subscribe/unsub?id=${sub.id}&token=${this.subscribers.unsubToken(sub)}`
					: null
			});
			void fetch(sub.url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-status-signature': this.subscribers.signature(sub, payload)
				},
				body: payload,
				signal: AbortSignal.timeout(8000),
				dispatcher: this.egress.dispatcher
			} as FetchInit).catch(() => undefined);
		}
	}

	private async sendWithRetry(
		target: NotifyTargetConfig,
		msg: ReturnType<typeof renderMessage>,
		cfg: StatusConfig['notifications']
	) {
		let result = await sendToTarget(target, msg, cfg.timeout_ms, this.egress);
		for (let i = 0; i < cfg.retries && !result.ok; i++) {
			await new Promise((r) => setTimeout(r, 500 * (i + 1)));
			result = await sendToTarget(target, msg, cfg.timeout_ms, this.egress);
		}
		if (!result.ok) {
			console.warn(`[notify] ${target.name} delivery failed: ${result.error}`);
		}
		return result;
	}

	/** Panel "send test" button. Returns the delivery result. */
	async sendTest(targetName: string): Promise<{ ok: boolean; error: string | null }> {
		const cfg = this.config();
		const target = cfg.notifications.targets.find((t) => t.name === targetName);
		if (!target) return { ok: false, error: 'unknown target' };
		const msg = renderMessage({
			event: 'test',
			siteName: cfg.site.name,
			siteUrl: cfg.site.url ?? null
		});
		const result = await this.sendWithRetry(target, msg, cfg.notifications);
		await this.log.record({
			target: target.name,
			kind: target.type,
			event: 'test',
			serviceId: null,
			ok: result.ok,
			status: result.status,
			error: result.error
		});
		return { ok: result.ok, error: result.error };
	}
}
