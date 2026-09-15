import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '$lib/server/store/db';
import { NotificationLog } from '$lib/server/notify/log';
import { NotifyDispatcher } from '$lib/server/notify/dispatcher';
import { renderMessage } from '$lib/server/notify/templates';
import { sendToTarget } from '$lib/server/notify/senders';
import { makeEgress } from '$lib/server/http/egress';
import type { NotifyTargetConfig, StatusConfig } from '$lib/server/config/schema';

const egress = makeEgress(() => false);

function cfgWith(notifications: Partial<StatusConfig['notifications']> = {}): StatusConfig {
	return {
		site: {
			name: 'Test Co',
			url: 'https://status.example.com',
			description: '',
			accent: '#fff',
			announcement_severity: 'info',
			frame_ancestors: ["'self'"]
		},
		page: { refresh_seconds: 30, history_days: 90, show_uptime_legend: true },
		monitor: {
			concurrency: 8,
			default_interval_seconds: 60,
			default_timeout_ms: 10000,
			default_degraded_ms: 1500,
			failure_threshold: 2,
			recovery_threshold: 2,
			retention_days: 400,
			cert_warn_days: 14,
			allow_link_local: false
		},
		services: [],
		incidents: [],
		maintenance: [],
		pages: [],
		links: [],
		slos: [],
		admin: {
			enabled: true,
			base_path: '/admin',
			session_ttl_hours: 12,
			invite_ttl_hours: 72,
			password_min_length: 12,
			login_max_attempts: 5,
			login_lockout_minutes: 15,
			allow_setup: true
		},
		oidc: {
			enabled: false,
			issuer: 'https://auth.example.com',
			client_id: '',
			client_secret: '',
			scopes: 'openid profile email groups',
			button_label: 'Sign in with SSO',
			username_claim: 'preferred_username',
			groups_claim: 'groups',
			admin_group: '',
			operator_group: '',
			default_role: 'deny',
			sync_profile: true
		},
		ldap: {
			enabled: false,
			url: '',
			starttls: false,
			bind_dn: '',
			search_bind_dn: '',
			search_bind_password: '',
			search_base: '',
			user_filter: '(uid={username})',
			display_attr: 'cn',
			admin_group: '',
			operator_group: '',
			default_role: 'deny',
			timeout_ms: 8000
		},
		ingress: {
			enabled: true,
			max_body_kb: 512,
			sample_retention_days: 30,
			online_seconds: 90,
			alert_offline_minutes: 10,
			alert_cpu_pct: 0,
			alert_mem_pct: 0,
			alert_disk_pct: 0
		},
		notifications: {
			enabled: true,
			cooldown_seconds: 300,
			timeout_ms: 8000,
			retries: 0,
			targets: [],
			...notifications
		},
		telemetry: {
			enabled: false,
			dsn: '',
			environment: 'test',
			client_reports: true,
			max_per_minute: 60
		},
		storage: {
			driver: 'sqlite',
			url: '',
			ns: 'wharfinger',
			db: 'wharfinger',
			user: '',
			pass: '',
			timeout_ms: 30_000
		}
	};
}

function target(over: Partial<NotifyTargetConfig> = {}): NotifyTargetConfig {
	return {
		name: 'hook1',
		type: 'webhook',
		url: 'https://hooks.example.com/x',
		events: ['down', 'degraded', 'recovered', 'maintenance', 'incident'],
		services: ['all'],
		enabled: true,
		...over
	};
}

function mockFetch(status = 200) {
	const calls: { url: string; init: RequestInit }[] = [];
	vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return Promise.resolve(new Response('ok', { status }));
	});
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('renderMessage', () => {
	const base = { siteName: 'Test Co', siteUrl: 'https://status.example.com' };

	it('renders a down event with urgent priority', () => {
		const m = renderMessage({ ...base, event: 'down', serviceName: 'Web', status: 'major_outage' });
		expect(m.title).toBe('Web is down');
		expect(m.priority).toBe(5);
		expect(m.tags).toContain('rotating_light');
		expect(m.body).toContain('Major Outage');
		expect(m.body).toContain('https://status.example.com');
	});

	it('renders a test event', () => {
		const m = renderMessage({ ...base, event: 'test' });
		expect(m.title).toBe('Test Co: test notification');
		expect(m.body).toContain('working');
	});

	it('includes the service line for incident events', () => {
		const m = renderMessage({
			...base,
			event: 'incident',
			serviceName: 'API',
			detail: 'investigating'
		});
		expect(m.body).toContain('Service: API');
		expect(m.body).toContain('investigating');
	});
});

describe('sendToTarget', () => {
	it('posts ntfy headers with bearer auth for tk_ tokens', async () => {
		const calls = mockFetch();
		const r = await sendToTarget(
			target({
				type: 'ntfy',
				url: 'https://ntfy.example.com/topic',
				token: 'tk_secret',
				priority: 'urgent'
			}),
			renderMessage({
				event: 'down',
				serviceName: 'Web',
				status: 'major_outage',
				siteName: 'T',
				siteUrl: null
			}),
			5000,
			egress
		);
		expect(r.ok).toBe(true);
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer tk_secret');
		expect(headers.Title).toBe('Web is down');
		expect(headers.Priority).toBe('5');
	});

	it('posts ntfy basic auth for user:pass tokens', async () => {
		const calls = mockFetch();
		await sendToTarget(
			target({ type: 'ntfy', url: 'https://ntfy.example.com/t', token: 'user:pass' }),
			renderMessage({ event: 'test', siteName: 'T', siteUrl: null }),
			5000,
			egress
		);
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
	});

	it('posts plain text to unifiedpush endpoints', async () => {
		const calls = mockFetch();
		await sendToTarget(
			target({ type: 'unifiedpush', url: 'https://push.example.com/up?token=abc' }),
			renderMessage({
				event: 'down',
				serviceName: 'Web',
				status: 'partial_outage',
				siteName: 'T',
				siteUrl: null
			}),
			5000,
			egress
		);
		expect(calls[0].init.body as string).toContain('Web is down');
	});

	it('posts json to generic webhooks', async () => {
		const calls = mockFetch();
		await sendToTarget(
			target({ url: 'https://hooks.example.com/x', token: 'Bearer abc' }),
			renderMessage({ event: 'test', siteName: 'T', siteUrl: null }),
			5000,
			egress
		);
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers['content-type']).toBe('application/json');
		expect(headers.Authorization).toBe('Bearer abc');
		const body = JSON.parse(calls[0].init.body as string) as { title: string };
		expect(body.title).toBe('T: test notification');
	});

	it('posts a block kit payload to slack webhooks', async () => {
		const calls = mockFetch();
		const r = await sendToTarget(
			target({ type: 'slack', url: 'https://hooks.slack.com/services/x' }),
			renderMessage({
				event: 'down',
				serviceName: 'Web',
				status: 'major_outage',
				siteName: 'T',
				siteUrl: null
			}),
			5000,
			egress
		);
		expect(r.ok).toBe(true);
		const body = JSON.parse(calls[0].init.body as string) as {
			text: string;
			blocks: { type: string; text: { type: string; text: string } }[];
		};
		expect(body.text).toContain('Web is down');
		expect(body.blocks[0].type).toBe('section');
		expect(body.blocks[0].text.text).toContain('*Web is down*');
	});

	it('posts an embed colored by event kind to discord', async () => {
		const calls = mockFetch();
		await sendToTarget(
			target({ type: 'discord', url: 'https://discord.com/api/webhooks/x' }),
			renderMessage({
				event: 'recovered',
				serviceName: 'Web',
				status: 'operational',
				siteName: 'T',
				siteUrl: 'https://status.example.com'
			}),
			5000,
			egress
		);
		const body = JSON.parse(calls[0].init.body as string) as {
			content: string;
			embeds: { title: string; description: string; color: number; url?: string }[];
		};
		expect(body.content).toContain('Web recovered');
		expect(body.embeds[0].color).toBe(0x2ea043);
		expect(body.embeds[0].url).toBe('https://status.example.com');
	});

	it('posts a MessageCard to teams webhooks', async () => {
		const calls = mockFetch();
		await sendToTarget(
			target({ type: 'teams', url: 'https://outlook.office.com/webhook/x' }),
			renderMessage({
				event: 'down',
				serviceName: 'Web',
				status: 'partial_outage',
				siteName: 'T',
				siteUrl: null
			}),
			5000,
			egress
		);
		const body = JSON.parse(calls[0].init.body as string) as {
			'@type': string;
			'@context': string;
			themeColor: string;
			summary: string;
			sections: { activityTitle: string; text: string }[];
		};
		expect(body['@type']).toBe('MessageCard');
		expect(body.themeColor).toBe('d64545');
		expect(body.summary).toBe('Web is down');
		expect(body.sections[0].activityTitle).toBe('Web is down');
	});

	it('posts escaped HTML to the telegram bot api', async () => {
		const calls = mockFetch();
		await sendToTarget(
			target({
				type: 'telegram',
				bot_token: '123:abc',
				chat_id: '-1001'
			}),
			renderMessage({
				event: 'down',
				serviceName: 'Web <edge>',
				status: 'major_outage',
				siteName: 'T',
				siteUrl: null
			}),
			5000,
			egress
		);
		expect(calls[0].url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
		const body = JSON.parse(calls[0].init.body as string) as {
			chat_id: string;
			text: string;
			parse_mode: string;
			disable_web_page_preview: boolean;
		};
		expect(body.chat_id).toBe('-1001');
		expect(body.parse_mode).toBe('HTML');
		expect(body.disable_web_page_preview).toBe(true);
		expect(body.text).toContain('&lt;edge&gt;');
		expect(body.text).not.toContain('<edge>');
	});

	it('posts to <url>/message with the token param for gotify', async () => {
		const calls = mockFetch();
		await sendToTarget(
			target({
				type: 'gotify',
				url: 'https://gotify.example.com/',
				token: 'app-token',
				priority: 'high'
			}),
			renderMessage({ event: 'test', siteName: 'T', siteUrl: null }),
			5000,
			egress
		);
		expect(calls[0].url).toBe('https://gotify.example.com/message?token=app-token');
		const body = JSON.parse(calls[0].init.body as string) as {
			title: string;
			message: string;
			priority: number;
		};
		expect(body.title).toBe('T: test notification');
		expect(body.priority).toBe(8);
	});

	it('posts token, user and optional url to pushover', async () => {
		const calls = mockFetch();
		await sendToTarget(
			target({ type: 'pushover', token: 'api-tok', user: 'user-key', priority: 'urgent' }),
			renderMessage({
				event: 'down',
				serviceName: 'Web',
				status: 'major_outage',
				siteName: 'T',
				siteUrl: 'https://status.example.com'
			}),
			5000,
			egress
		);
		expect(calls[0].url).toBe('https://api.pushover.net/1/messages.json');
		const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
		expect(body.token).toBe('api-tok');
		expect(body.user).toBe('user-key');
		expect(body.title).toBe('Web is down');
		expect(body.priority).toBe(2);
		expect(body.retry).toBe(60);
		expect(body.expire).toBe(600);
		expect(body.url).toBe('https://status.example.com');
	});

	it('truncates oversized message text', async () => {
		const calls = mockFetch();
		await sendToTarget(
			target({ type: 'slack', url: 'https://hooks.slack.com/services/x' }),
			renderMessage({
				event: 'incident',
				serviceName: 'API',
				detail: 'x'.repeat(5000),
				siteName: 'T',
				siteUrl: null
			}),
			5000,
			egress
		);
		const body = JSON.parse(calls[0].init.body as string) as { text: string };
		expect(body.text.length).toBeLessThanOrEqual(4000);
	});

	it('reports failures with status and error', async () => {
		mockFetch(500);
		const r = await sendToTarget(
			target(),
			renderMessage({ event: 'test', siteName: 'T', siteUrl: null }),
			5000,
			egress
		);
		expect(r.ok).toBe(false);
		expect(r.status).toBe(500);
		expect(r.error).toBe('HTTP 500');
	});

	it('reports network errors', async () => {
		vi.stubGlobal('fetch', () => Promise.reject(new Error('connection refused')));
		const r = await sendToTarget(
			target(),
			renderMessage({ event: 'test', siteName: 'T', siteUrl: null }),
			5000,
			egress
		);
		expect(r.ok).toBe(false);
		expect(r.error).toBe('connection refused');
	});
});

describe('NotifyDispatcher', () => {
	function setup(cfg: StatusConfig): {
		db: DatabaseSync;
		log: NotificationLog;
		d: NotifyDispatcher;
	} {
		const db = openDb(mkdtempSync(join(tmpdir(), 'wharfinger-notify-')));
		const log = new NotificationLog(db);
		return { db, log, d: new NotifyDispatcher(() => cfg, log, egress) };
	}

	it('delivers matching events and writes the log', async () => {
		const calls = mockFetch();
		const { log, d } = setup(cfgWith({ targets: [target()] }));
		await d.notify({ event: 'down', serviceId: 'web', serviceName: 'Web', status: 'major_outage' });
		expect(calls).toHaveLength(1);
		const entries = await log.recent();
		expect(entries).toHaveLength(1);
		expect(entries[0].event).toBe('down');
		expect(entries[0].ok).toBeTruthy();
	});

	it('suppresses repeat sends inside the cooldown window', async () => {
		const calls = mockFetch();
		const { d } = setup(cfgWith({ targets: [target()], cooldown_seconds: 3600 }));
		await d.notify({ event: 'down', serviceId: 'web', serviceName: 'Web' });
		await d.notify({ event: 'down', serviceId: 'web', serviceName: 'Web' });
		expect(calls).toHaveLength(1);
	});

	it('does not cooldown across different services', async () => {
		const calls = mockFetch();
		const { d } = setup(cfgWith({ targets: [target()], cooldown_seconds: 3600 }));
		await d.notify({ event: 'down', serviceId: 'web', serviceName: 'Web' });
		await d.notify({ event: 'down', serviceId: 'api', serviceName: 'API' });
		expect(calls).toHaveLength(2);
	});

	it('skips targets whose event filter excludes the event', async () => {
		const calls = mockFetch();
		const { d } = setup(cfgWith({ targets: [target({ events: ['recovered'] })] }));
		await d.notify({ event: 'down', serviceId: 'web', serviceName: 'Web' });
		expect(calls).toHaveLength(0);
	});

	it('skips targets whose service filter excludes the service', async () => {
		const calls = mockFetch();
		const { d } = setup(cfgWith({ targets: [target({ services: ['api'] })] }));
		await d.notify({ event: 'down', serviceId: 'web', serviceName: 'Web' });
		expect(calls).toHaveLength(0);
	});

	it('skips disabled targets and disabled notifications', async () => {
		const calls = mockFetch();
		const { d } = setup(cfgWith({ targets: [target({ enabled: false }), target({ name: 'b' })] }));
		await d.notify({ event: 'down', serviceId: 'web', serviceName: 'Web' });
		expect(calls).toHaveLength(1);

		const { d: d2 } = setup(cfgWith({ enabled: false, targets: [target()] }));
		await d2.notify({ event: 'down', serviceId: 'web', serviceName: 'Web' });
		expect(calls).toHaveLength(1);
	});

	it('sendTest bypasses cooldown and reports the result', async () => {
		const calls = mockFetch();
		const { d } = setup(cfgWith({ targets: [target()], cooldown_seconds: 3600 }));
		const r1 = await d.sendTest('hook1');
		const r2 = await d.sendTest('hook1');
		expect(r1.ok).toBe(true);
		expect(r2.ok).toBe(true);
		expect(calls).toHaveLength(2);
		expect((await d.sendTest('missing')).ok).toBe(false);
	});
});
