import type { NotifyEvent } from '$lib/server/config/schema';
import type { ServiceStatus } from '$lib/shared/status';
import { STATUS_LABEL } from '$lib/shared/status';

export interface NotifyMessage {
	title: string;
	body: string;
	tags: string[];
	/** ntfy priority 1-5. */
	priority: number;
	clickUrl: string | null;
	/** The event kind that produced this message. */
	event: NotifyContext['event'];
}

export interface NotifyContext {
	event: NotifyEvent | 'test';
	serviceId?: string | null;
	serviceName?: string | null;
	status?: ServiceStatus | null;
	detail?: string | null;
	siteName: string;
	siteUrl: string | null;
}

const EVENT_META: Record<string, { label: string; tags: string[]; priority: number }> = {
	down: { label: 'is down', tags: ['rotating_light', 'x'], priority: 5 },
	degraded: { label: 'is degraded', tags: ['warning'], priority: 4 },
	recovered: { label: 'recovered', tags: ['white_check_mark'], priority: 3 },
	maintenance: { label: 'entered maintenance', tags: ['hammer_and_wrench'], priority: 3 },
	incident: { label: 'has a new incident', tags: ['rotating_light'], priority: 4 },
	test: { label: 'test notification', tags: ['test_tube'], priority: 2 }
};

export function renderMessage(ctx: NotifyContext): NotifyMessage {
	const meta = EVENT_META[ctx.event] ?? EVENT_META.test;
	const name = ctx.serviceName ?? ctx.serviceId ?? ctx.siteName;
	const title =
		ctx.event === 'test' ? `${ctx.siteName}: test notification` : `${name} ${meta.label}`;

	const lines: string[] = [];
	if (ctx.event === 'test') {
		lines.push(`Notifications from ${ctx.siteName} are working.`);
	} else {
		if (ctx.status) lines.push(`Status: ${STATUS_LABEL[ctx.status]}`);
		if (ctx.detail) lines.push(ctx.detail);
		if (ctx.event === 'incident' && ctx.serviceName) lines.push(`Service: ${ctx.serviceName}`);
	}
	if (ctx.siteUrl) lines.push(ctx.siteUrl);

	return {
		title,
		body: lines.join('\n'),
		tags: meta.tags,
		priority: meta.priority,
		clickUrl: ctx.siteUrl,
		event: ctx.event
	};
}
