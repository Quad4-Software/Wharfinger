import { describe, expect, it } from 'vitest';
import { filterSnapshot, pageCovers } from '$lib/shared/pages';
import type { Incident, PageMeta, ServiceSnapshot, StatusSnapshot } from '$lib/shared/types';
import type { ServiceStatus } from '$lib/shared/status';

function svc(id: string, status: ServiceStatus): ServiceSnapshot {
	return {
		id,
		name: id.toUpperCase(),
		description: null,
		status,
		latencyMs: null,
		uptime: { d24: null, d7: null, d30: null, d90: null },
		latency: [],
		days: [],
		inMaintenance: false,
		lastCheckedAt: null,
		lastDetail: null,
		certDays: null,
		certWarn: false,
		icon: null,
		groupIds: []
	};
}

function inc(id: string, services: string[]): Incident {
	return {
		id,
		title: id,
		severity: 'major',
		services,
		startedAt: '2026-01-01T00:00:00Z',
		resolvedAt: null,
		updates: [],
		source: 'auto'
	};
}

const snap: StatusSnapshot = {
	generatedAt: '2026-09-13T12:00:00Z',
	site: {
		name: 'Test',
		title: 'Test Status',
		description: '',
		url: null,
		logoUrl: null,
		accent: '#fff',
		announcement: null,
		links: []
	},
	overall: 'major_outage',
	groups: [
		{
			name: 'G',
			services: [svc('a', 'operational'), svc('b', 'major_outage'), svc('c', 'degraded')]
		}
	],
	incidents: {
		active: [inc('i1', ['b'])],
		recent: [inc('i2', ['a'])]
	},
	maintenance: {
		active: [],
		upcoming: [
			{
				id: 'm1',
				title: 'patch',
				description: null,
				services: ['a'],
				startsAt: '2026-09-15T02:00:00Z',
				endsAt: '2026-09-15T04:00:00Z',
				active: false,
				weekly: 'tue'
			},
			{
				id: 'm2',
				title: 'all-maint',
				description: null,
				services: ['*'],
				startsAt: '2026-09-15T02:00:00Z',
				endsAt: '2026-09-15T04:00:00Z',
				active: false,
				weekly: null
			}
		]
	},
	pages: [
		{ slug: 'ab', title: 'AB', description: null, accent: null, services: ['a', 'b'] },
		{ slug: 'allp', title: 'Everything', description: null, accent: null, services: ['*'] }
	],
	serviceGroups: [],
	historyDays: 90,
	refreshSeconds: 30
};

describe('pageCovers', () => {
	it('matches wildcard and explicit ids', () => {
		const all: PageMeta = {
			slug: 'x',
			title: 'X',
			description: null,
			accent: null,
			services: ['*']
		};
		const ab = snap.pages[0];
		expect(pageCovers(all, 'anything')).toBe(true);
		expect(pageCovers(ab, 'a')).toBe(true);
		expect(pageCovers(ab, 'c')).toBe(false);
	});
});

describe('filterSnapshot', () => {
	it('keeps every service for the wildcard page and applies the title', () => {
		const out = filterSnapshot(snap, snap.pages[1]);
		expect(out.groups[0].services).toHaveLength(3);
		expect(out.overall).toBe('major_outage');
		expect(out.site.title).toBe('Everything');
	});

	it('filters services, recomputes groups and overall', () => {
		const out = filterSnapshot(snap, snap.pages[0]);
		expect(out.groups).toHaveLength(1);
		expect(out.groups[0].services.map((s) => s.id)).toEqual(['a', 'b']);
		expect(out.overall).toBe('major_outage');
	});

	it('drops incidents and maintenance outside the page scope, keeps wildcard windows', () => {
		const p: PageMeta = { slug: 'c', title: 'C', description: null, accent: null, services: ['c'] };
		const out = filterSnapshot(snap, p);
		expect(out.incidents.active).toHaveLength(0);
		expect(out.incidents.recent).toHaveLength(0);
		expect(out.maintenance.upcoming.map((w) => w.id)).toEqual(['m2']);
		expect(out.overall).toBe('degraded');
	});

	it('applies page description and accent overrides', () => {
		const p: PageMeta = {
			slug: 'x',
			title: 'Custom',
			description: 'custom desc',
			accent: '#f00',
			services: ['*']
		};
		const out = filterSnapshot(snap, p);
		expect(out.site.title).toBe('Custom');
		expect(out.site.description).toBe('custom desc');
		expect(out.site.accent).toBe('#f00');
	});
});
