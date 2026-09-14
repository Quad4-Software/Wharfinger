import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '$lib/server/store/db';
import { PushStore, pushToken, tokenMatches } from '$lib/server/store/push';
import { MarkerStore } from '$lib/server/store/markers';
import { ApiKeyStore } from '$lib/server/store/apikeys';
import { SubscriberStore } from '$lib/server/store/subscribers';
import { runCheck } from '$lib/server/monitor/checkers';
import { makeEgress } from '$lib/server/http/egress';
import type { ServiceConfig, StatusConfig } from '$lib/server/config/schema';
import { NotifyDispatcher } from '$lib/server/notify/dispatcher';
import { NotificationLog } from '$lib/server/notify/log';
import type { Monitor } from '$lib/server/monitor/monitor';

function db(): DatabaseSync {
	return openDb(mkdtempSync(join(tmpdir(), 'wharfinger-obs-')));
}

describe('PushStore', () => {
	it('records beats and reports the latest', () => {
		const s = new PushStore(db());
		expect(s.lastBeat('web')).toBeNull();
		s.beat('web', 'ok');
		s.beat('web', 'done');
		const info = s.info('web');
		expect(info?.beats).toBe(2);
		expect(info?.lastMsg).toBe('done');
		expect(info?.lastBeat).toBeGreaterThan(0);
	});

	it('derives stable, per-service tokens', () => {
		const d = db();
		expect(pushToken(d, 'web')).toBe(pushToken(d, 'web'));
		expect(pushToken(d, 'web')).not.toBe(pushToken(d, 'api'));
		expect(pushToken(d, 'web')).toMatch(/^[0-9a-f]{32}$/);
		expect(tokenMatches(d, 'web', pushToken(d, 'web'))).toBe(true);
		expect(tokenMatches(d, 'web', pushToken(d, 'api'))).toBe(false);
		expect(tokenMatches(d, 'web', 'short')).toBe(false);
	});

	it('prunes beats for removed services', () => {
		const s = new PushStore(db());
		s.beat('web', null);
		s.beat('api', null);
		s.prune(['web']);
		expect(s.lastBeat('web')).not.toBeNull();
		expect(s.lastBeat('api')).toBeNull();
	});
});

describe('MarkerStore', () => {
	it('adds, lists, filters, and removes markers', () => {
		const s = new MarkerStore(db());
		const now = Date.now();
		s.add({ ts: now - 1000, title: 'v1', kind: 'release', service: 'web' });
		s.add({ ts: now, title: 'note', kind: 'note' });
		const all = s.between(now - 2000, now + 1000);
		expect(all).toHaveLength(2);
		const web = s.between(now - 2000, now + 1000, 'web');
		expect(web.map((m) => m.title).sort()).toEqual(['note', 'v1']);
		const api = s.between(now - 2000, now + 1000, 'api');
		expect(api.map((m) => m.title)).toEqual(['note']);
		const { entries, total } = s.list({ limit: 10 });
		expect(total).toBe(2);
		expect(entries[0].title).toBe('note');
		expect(s.remove(all[0].id)).toBe(true);
		expect(s.list({ limit: 10 }).total).toBe(1);
	});

	it('clamps far-future timestamps and bad kinds', () => {
		const s = new MarkerStore(db());
		const m = s.add({ ts: Date.now() + 3_600_000, title: 'future', kind: 'bogus' as never });
		expect(m.ts).toBeLessThanOrEqual(Date.now() + 60_000);
		expect(m.kind).toBe('note');
	});

	it('detects recent titles for auto-marker dedupe', () => {
		const s = new MarkerStore(db());
		s.add({ title: 'release 1.2.3' });
		expect(s.exists('release 1.2.3', Date.now() - 60_000)).toBe(true);
		expect(s.exists('release 9.9.9', Date.now() - 60_000)).toBe(false);
	});
});

describe('ApiKeyStore', () => {
	it('creates keys with shown-once tokens and resolves by hash', () => {
		const s = new ApiKeyStore(db());
		const { key, token } = s.create('ci', ['read'], 'admin');
		expect(token).toMatch(/^qs_[0-9a-f]{48}$/);
		const resolved = s.resolve(token);
		expect(resolved?.id).toBe(key.id);
		expect(resolved?.scopes).toEqual(['read']);
		expect(s.resolve(`qs_${'0'.repeat(48)}`)).toBeNull();
		expect(s.resolve('garbage')).toBeNull();
		expect(s.resolve('')).toBeNull();
	});

	it('honors disable and delete', () => {
		const s = new ApiKeyStore(db());
		const { key, token } = s.create('ci', ['read', 'write'], null);
		expect(s.setDisabled(key.id, true)).toBe(true);
		expect(s.resolve(token)).toBeNull();
		expect(s.setDisabled(key.id, false)).toBe(true);
		expect(s.resolve(token)?.id).toBe(key.id);
		expect(s.remove(key.id)).toBe(true);
		expect(s.resolve(token)).toBeNull();
	});

	it('lists keys without exposing hashes', () => {
		const s = new ApiKeyStore(db());
		s.create('a', ['read'], 'x');
		s.create('b', ['write'], 'x');
		const keys = s.list();
		expect(keys).toHaveLength(2);
		expect(JSON.stringify(keys)).not.toContain('key_hash');
		expect(keys[1].scopes).toEqual(['write']);
	});
});

describe('SubscriberStore', () => {
	it('creates pending subscribers and confirms via one-shot token', () => {
		const s = new SubscriberStore(db());
		const c = s.create('https://hook.example.com/x', ['all']);
		expect(c).not.toBeNull();
		const { sub, confirmToken } = c!;
		expect(sub.confirmedAt).toBeNull();
		expect(s.active(null)).toHaveLength(0);
		expect(s.confirm('bad-token')).toBe(false);
		expect(s.confirm(confirmToken)).toBe(true);
		expect(s.confirm(confirmToken)).toBe(false);
		expect(s.active(null)).toHaveLength(1);
	});

	it('re-subscribing resets confirmation without leaking', () => {
		const s = new SubscriberStore(db());
		const c1 = s.create('https://hook.example.com/x', ['all'])!;
		expect(s.confirm(c1.confirmToken)).toBe(true);
		const c2 = s.create('https://hook.example.com/x', ['web'])!;
		expect(c2.sub.confirmedAt).toBeNull();
		expect(s.active(null)).toHaveLength(0);
		expect(s.confirm(c2.confirmToken)).toBe(true);
		expect(s.active('web')).toHaveLength(1);
		expect(s.active('api')).toHaveLength(0);
	});

	it('filters by service and unsubscribes via signed token', () => {
		const s = new SubscriberStore(db());
		const c = s.create('https://hook.example.com/x', ['web'])!;
		s.confirm(c.confirmToken);
		expect(s.active('web')).toHaveLength(1);
		expect(s.active('api')).toHaveLength(0);
		const sub = s.list()[0];
		const token = s.unsubToken(sub);
		expect(s.unsubscribe(sub.id, 'wrong-token-00000000000000000000')).toBe(false);
		expect(s.unsubscribe(sub.id, token)).toBe(true);
		expect(s.active('web')).toHaveLength(0);
	});

	it('signs payloads deterministically per subscriber', () => {
		const s = new SubscriberStore(db());
		const a = s.create('https://a.example.com/x', ['all'])!;
		const b = s.create('https://b.example.com/x', ['all'])!;
		const body = JSON.stringify({ ping: true });
		expect(s.signature(a.sub, body)).toBe(s.signature(a.sub, body));
		expect(s.signature(a.sub, body)).not.toBe(s.signature(b.sub, body));
	});
});

describe('push checker', () => {
	const egress = makeEgress(() => true);
	const svc = {
		id: 'cron',
		name: 'Cron',
		type: 'push',
		group: 'g',
		expected_interval_seconds: 300,
		grace_seconds: 60,
		interval_seconds: 30,
		timeout_ms: 5000,
		degraded_ms: 1000
	} as ServiceConfig;

	const ctx = (lastBeat: number | null) => ({
		timeoutMs: 5000,
		degradedMs: 1000,
		userAgent: 'test',
		certWarnDays: 14,
		egress,
		lastBeat: () => lastBeat
	});

	it('reports degraded until the first beat arrives', async () => {
		const r = await runCheck(svc, ctx(null));
		expect(r.ok).toBe(true);
		expect(r.degraded).toBe(true);
		expect(r.detail).toContain('first check-in');
	});

	it('is up inside expected interval + grace', async () => {
		const r = await runCheck(svc, ctx(Date.now() - 120_000));
		expect(r.ok).toBe(true);
		expect(r.degraded).toBe(false);
	});

	it('is up during the grace tail', async () => {
		const r = await runCheck(svc, ctx(Date.now() - 330_000));
		expect(r.ok).toBe(true);
	});

	it('goes down past interval + grace', async () => {
		const r = await runCheck(svc, ctx(Date.now() - 400_000));
		expect(r.ok).toBe(false);
		expect(r.detail).toContain('no check-in');
	});
});

describe('maintenance alert suppression', () => {
	const egress = makeEgress(() => false);

	function cfg(maintenance: StatusConfig['maintenance']): StatusConfig {
		return {
			site: {
				name: 't',
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
			maintenance,
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
				scopes: 'openid',
				button_label: 'SSO',
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
				cooldown_seconds: 0,
				timeout_ms: 8000,
				retries: 0,
				targets: [
					{
						name: 'hook',
						type: 'webhook',
						url: 'https://hooks.example.com/x',
						events: ['down', 'degraded', 'recovered'],
						services: ['all'],
						enabled: true
					}
				]
			},
			telemetry: {
				enabled: false,
				dsn: '',
				environment: 'test',
				client_reports: true,
				max_per_minute: 60
			}
		};
	}

	function rig(c: StatusConfig) {
		const d = openDb(mkdtempSync(join(tmpdir(), 'wharfinger-obs-')));
		const monitor = new EventEmitter();
		const disp = new NotifyDispatcher(() => c, new NotificationLog(d), egress);
		disp.attach(monitor as unknown as Monitor);
		const calls: unknown[] = [];
		vi.stubGlobal('fetch', (...a: unknown[]) => {
			calls.push(a);
			return Promise.resolve(new Response('ok'));
		});
		return { monitor, disp, calls };
	}

	const svcOf = (id: string) => ({ id, name: id }) as ServiceConfig;
	const activeWindow = (services: string[]): StatusConfig['maintenance'] => [
		{
			title: 'deploy',
			services,
			start: new Date(Date.now() - 3600_000).toISOString(),
			end: new Date(Date.now() + 3600_000).toISOString()
		}
	];

	afterEach(() => vi.unstubAllGlobals());

	it('silences down and degraded inside an active window', async () => {
		const { monitor, disp, calls } = rig(cfg(activeWindow(['web'])));
		monitor.emit('transition', {
			service: svcOf('web'),
			prev: 'operational',
			next: 'major_outage'
		});
		monitor.emit('transition', {
			service: svcOf('web'),
			prev: 'major_outage',
			next: 'degraded'
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(calls).toHaveLength(0);
		disp.stop();
	});

	it('alerts services outside the window and still sends recovered', async () => {
		const { monitor, disp, calls } = rig(cfg(activeWindow(['api'])));
		monitor.emit('transition', {
			service: svcOf('web'),
			prev: 'operational',
			next: 'major_outage'
		});
		monitor.emit('transition', {
			service: svcOf('api'),
			prev: 'major_outage',
			next: 'operational'
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(calls).toHaveLength(2);
		disp.stop();
	});

	it('an expired window stops suppressing', async () => {
		const { monitor, disp, calls } = rig(
			cfg([
				{
					title: 'old',
					services: ['all'],
					start: new Date(Date.now() - 7200_000).toISOString(),
					end: new Date(Date.now() - 3600_000).toISOString()
				}
			])
		);
		monitor.emit('transition', {
			service: svcOf('web'),
			prev: 'operational',
			next: 'major_outage'
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(calls).toHaveLength(1);
		disp.stop();
	});
});
