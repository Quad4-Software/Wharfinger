import { describe, expect, it } from 'vitest';
import { expandWindows, weeklyOccurrences } from '$lib/server/status/snapshot';
import type { StatusConfig } from '$lib/server/config/schema';

const DAY = 86_400_000;
// 2026-09-13 is a Sunday. Tuesdays nearby: Sep 8 and Sep 15.
const NOW = Date.parse('2026-09-13T12:00:00Z');

describe('weeklyOccurrences', () => {
	it('expands a weekly window across the range', () => {
		const occ = weeklyOccurrences('tue', '02:00', 120, NOW - 14 * DAY, NOW + 14 * DAY);
		expect(occ.length).toBe(4); // Sep 1, 8, 15, 22
		for (const o of occ) {
			expect(new Date(o.start).getUTCDay()).toBe(2);
			expect(new Date(o.start).getUTCHours()).toBe(2);
			expect(o.end - o.start).toBe(120 * 60_000);
		}
	});

	it('includes an in-progress occurrence that started before `from`', () => {
		const during = Date.parse('2026-09-08T03:00:00Z'); // inside Tue 02:00-04:00
		const occ = weeklyOccurrences('tue', '02:00', 120, during, during + DAY);
		expect(occ.some((o) => o.start <= during && o.end >= during)).toBe(true);
	});

	it('handles windows crossing midnight', () => {
		const occ = weeklyOccurrences('tue', '23:00', 240, NOW - DAY, NOW + 7 * DAY);
		expect(occ.length).toBe(1);
		expect(occ[0].end - occ[0].start).toBe(240 * 60_000);
	});
});

function cfgWith(maintenance: StatusConfig['maintenance']): StatusConfig {
	return {
		site: {
			name: 't',
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
			retries: 1,
			targets: []
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

describe('expandWindows', () => {
	it('keeps one-shot windows as single occurrences', () => {
		const out = expandWindows(
			cfgWith([
				{
					title: 'upgrade',
					services: ['web'],
					start: '2026-09-20T02:00:00Z',
					end: '2026-09-20T04:00:00Z'
				}
			]),
			NOW,
			90 * DAY
		);
		expect(out).toHaveLength(1);
		expect(out[0].weekly).toBeNull();
		expect(out[0].start).toBe(Date.parse('2026-09-20T02:00:00Z'));
	});

	it('expands weekly entries with the entry index preserved', () => {
		const out = expandWindows(
			cfgWith([
				{ title: 'patch', services: ['all'], weekly: 'tue', at: '02:00', duration_minutes: 120 }
			]),
			NOW,
			30 * DAY
		);
		expect(out.length).toBeGreaterThan(4); // ~30d back + ~42d ahead
		expect(out.every((w) => w.weekly === 'tue')).toBe(true);
		expect(out.every((w) => w.entryIdx === 0)).toBe(true);
	});
});
