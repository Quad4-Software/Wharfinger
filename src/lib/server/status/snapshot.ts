import { createHash } from 'node:crypto';
import {
	DAY_MS,
	RECENT_INCIDENTS_MAX,
	UPCOMING_WINDOW_DAYS,
	UPCOMING_WINDOW_MAX
} from '$lib/server/constants';
import type { StatusConfig } from '$lib/server/config/schema';
import { weeklyOccurrences } from '$lib/shared/maintenance';

export { weeklyOccurrences };
import type { IconCache } from '$lib/server/icons';
import type { Monitor } from '$lib/server/monitor/monitor';
import type { CheckStore } from '$lib/server/store/checks';
import type { IncidentStore } from '$lib/server/store/incidents';
import type { MarkerStore } from '$lib/server/store/markers';
import { groupSnapshotData } from '$lib/server/groups/store';
import { paths } from '$lib/shared/paths';
import { worstStatus } from '$lib/shared/status';
import {
	buildDayBuckets,
	buildLatencySeries,
	LATENCY_RANGES,
	uptimeFractionInRows
} from '$lib/shared/uptime';
import type {
	Incident,
	MaintenanceWindow,
	ServiceSnapshot,
	StatusSnapshot
} from '$lib/shared/types';

export interface SnapshotCache {
	json: string;
	etag: string;
	snapshot: StatusSnapshot;
}

/**
 * Builds and caches the public snapshot. The cache is rebuilt only when
 * the monitor reports new data (check recorded or state change), so
 * repeated API hits are an in-memory string compare away from a 304.
 */
export class SnapshotBuilder {
	private cached: SnapshotCache | null = null;
	private dirty = true;

	constructor(
		private readonly config: () => StatusConfig,
		private readonly monitor: Monitor,
		private readonly checks: CheckStore,
		private readonly incidents: IncidentStore,
		private readonly icons: IconCache,
		private readonly markers?: MarkerStore
	) {
		monitor.on('update', () => {
			this.dirty = true;
		});
		monitor.on('change', () => {
			this.dirty = true;
		});
	}

	invalidate(): void {
		this.dirty = true;
	}

	current(): SnapshotCache {
		if (this.dirty || !this.cached) {
			const snapshot = this.build();
			const json = JSON.stringify(snapshot);
			this.cached = {
				snapshot,
				json,
				etag: `W/"${createHash('sha256').update(json).digest('base64url').slice(0, 32)}"`
			};
			this.dirty = false;
		}
		return this.cached;
	}

	private build(): StatusSnapshot {
		const cfg = this.config();
		const now = Date.now();
		const days = cfg.page.history_days;
		const since90 = now - days * DAY_MS;

		const windows = expandWindows(cfg, now, days * DAY_MS + 7 * DAY_MS);
		const activeWindowServices = new Set(
			windows
				.filter((w) => w.start <= now && w.end >= now)
				.flatMap((w) => (w.services.includes('all') ? ['*'] : w.services))
		);

		// One pass over windows instead of a filter per service.
		const allWindows: ExpandedWindow[] = [];
		const windowsByService = new Map<string, ExpandedWindow[]>();
		for (const w of windows) {
			if (w.services.includes('all')) {
				allWindows.push(w);
				continue;
			}
			for (const id of w.services) {
				const l = windowsByService.get(id) ?? [];
				l.push(w);
				windowsByService.set(id, l);
			}
		}

		// Admin-managed service groups; one db read per build.
		const groupData = groupSnapshotData();

		const groupOrder: string[] = [];
		const groups = new Map<string, ServiceSnapshot[]>();
		for (const s of cfg.services) {
			let list = groups.get(s.group);
			if (!list) {
				list = [];
				groups.set(s.group, list);
				groupOrder.push(s.group);
			}
			list.push(
				this.buildService(
					s,
					now,
					since90,
					days,
					[...allWindows, ...(windowsByService.get(s.id) ?? [])],
					activeWindowServices,
					groupData.byService.get(s.id) ?? []
				)
			);
		}

		const groupSnapshots = groupOrder.map((name) => {
			const services = groups.get(name);
			return { name, services: services ?? [] };
		});
		const overall = worstStatus(groupSnapshots.flatMap((g) => g.services.map((s) => s.status)));

		const horizon = now + UPCOMING_WINDOW_DAYS * DAY_MS;
		const publicWindows = windows
			.filter((w) => w.end > now)
			.map((w) => toPublicWindow(w, now))
			.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

		// Recurring rules collapse to their next occurrence in the list;
		// the card still notes that they repeat weekly.
		const seenRecurring = new Set<string>();
		const upcoming = publicWindows.filter((w) => {
			if (w.active || Date.parse(w.startsAt) > horizon) return false;
			if (w.weekly) {
				const key = `${w.weekly}:${w.title}`;
				if (seenRecurring.has(key)) return false;
				seenRecurring.add(key);
			}
			return true;
		});

		return {
			generatedAt: new Date(now).toISOString(),
			site: {
				name: cfg.site.name,
				title: cfg.site.title ?? `${cfg.site.name} Status`,
				description: cfg.site.description,
				url: cfg.site.url ?? null,
				logoUrl: cfg.site.logo_url ?? null,
				accent: cfg.site.accent,
				announcement: cfg.site.announcement
					? { text: cfg.site.announcement, severity: cfg.site.announcement_severity }
					: null,
				links: cfg.links
			},
			overall,
			groups: groupSnapshots,
			incidents: this.buildIncidents(cfg),
			maintenance: {
				active: publicWindows.filter((w) => w.active),
				upcoming: upcoming.slice(0, UPCOMING_WINDOW_MAX)
			},
			pages: cfg.pages.map((p) => ({
				slug: p.slug,
				title: p.title,
				description: p.description ?? null,
				accent: p.accent ?? null,
				services: p.services.includes('all') ? ['*'] : p.services,
				noindex: p.noindex
			})),
			serviceGroups: groupData.groups,
			historyDays: days,
			refreshSeconds: cfg.page.refresh_seconds
		};
	}

	private buildService(
		s: StatusConfig['services'][number],
		now: number,
		since: number,
		days: number,
		serviceWindows: ExpandedWindow[],
		activeWindowServices: Set<string>,
		groupIds: string[]
	): ServiceSnapshot {
		const id = s.id;
		const inMaintenance = activeWindowServices.has(id) || activeWindowServices.has('*');
		const rows = this.checks.since(id, since - DAY_MS); // small overlap for day edges
		const windows = serviceWindows.map((w) => ({ start: w.start, end: w.end }));

		const status = this.monitor.serviceStatus.get(id) ?? 'unknown';
		const latest = this.checks.latest(id);
		const certDays = this.monitor.certDays.get(id) ?? null;
		const warnDays =
			(s.type === 'http' || s.type === 'tcp' ? s.cert_warn_days : undefined) ??
			this.config().monitor.cert_warn_days;
		const certWarn = certDays !== null && certDays <= warnDays;

		const sloCfg = this.config().slos.find((x) => x.service === id);

		// rows covers [rowsFrom, now]; uptime fractions inside that range are
		// counted from the rows instead of one aggregate query each.
		const rowsFrom = since - DAY_MS;
		const uptimeFrac = (from: number): number | null =>
			from >= rowsFrom ? uptimeFractionInRows(rows, from) : this.checks.uptimeFraction(id, from);

		const d = (ms: number) => this.fracToPct(uptimeFrac(now - ms));
		const slo = sloCfg
			? (() => {
					const windowMs = sloCfg.window_days * DAY_MS;
					const frac = uptimeFrac(now - windowMs);
					const hour = uptimeFrac(now - 3600_000);
					const allowed = (100 - sloCfg.target_percent) / 100;
					const budgetRemaining =
						frac === null || allowed <= 0
							? frac === null
								? null
								: 1
							: Math.max(0, Math.min(1, 1 - (1 - frac) / allowed));
					const burnRate = hour === null || allowed <= 0 ? null : (1 - hour) / allowed;
					return {
						target: sloCfg.target_percent,
						windowDays: sloCfg.window_days,
						uptime: frac,
						budgetRemaining,
						burnRate
					};
				})()
			: undefined;

		return {
			id,
			name: s.name,
			description: s.description ?? null,
			status: inMaintenance ? 'maintenance' : status,
			latencyMs: latest?.ok === 1 ? latest.latencyMs : null,
			uptime: {
				d24: d(DAY_MS),
				d7: d(7 * DAY_MS),
				d30: d(30 * DAY_MS),
				d90: d(90 * DAY_MS)
			},
			latency: buildLatencySeries({
				checks: rows.filter((r) => r.ts >= now - LATENCY_RANGES['24h'].ms),
				start: now - LATENCY_RANGES['24h'].ms,
				end: now,
				buckets: LATENCY_RANGES['24h'].buckets
			}),
			markers:
				this.markers
					?.between(now - LATENCY_RANGES['24h'].ms, now, id)
					.map((m) => ({ ts: m.ts, title: m.title, kind: m.kind })) ?? [],
			slo,
			days: buildDayBuckets({ now, days, checks: rows, maintenance: windows }),
			inMaintenance,
			lastCheckedAt: latest?.ts ?? null,
			lastDetail: latest?.detail ?? null,
			certDays,
			certWarn,
			icon: this.icons.has(id) ? paths.favicon(id) : null,
			groupIds
		};
	}

	private fracToPct(frac: number | null): number | null {
		return frac === null ? null : Math.round(frac * 10000) / 100;
	}

	private buildIncidents(cfg: StatusConfig): StatusSnapshot['incidents'] {
		const autoRows = [...this.incidents.allOpen(), ...this.incidents.recent(RECENT_INCIDENTS_MAX)];
		const dbUpdates = this.incidents.updatesFor(autoRows.map((r) => r.id));
		const auto: Incident[] = autoRows.map((r) => ({
			id: `auto-${r.id}`,
			title: r.title,
			severity: r.severity,
			services: [r.serviceId],
			startedAt: new Date(r.startedAt).toISOString(),
			resolvedAt: r.endedAt ? new Date(r.endedAt).toISOString() : null,
			updates: (dbUpdates.get(r.id) ?? []).map((u) => ({
				at: new Date(u.at).toISOString(),
				message: u.author ? `${u.message} (${u.author})` : u.message
			})),
			source: 'auto'
		}));

		const manual: Incident[] = cfg.incidents.map((i, idx) => ({
			id: `manual-${idx}`,
			title: i.title,
			severity: i.severity,
			services: i.services,
			startedAt: new Date(Date.parse(i.started_at)).toISOString(),
			resolvedAt: i.resolved_at ? new Date(Date.parse(i.resolved_at)).toISOString() : null,
			updates: i.updates
				.map((u) => ({ at: new Date(Date.parse(u.at)).toISOString(), message: u.message }))
				.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
			source: 'manual'
		}));

		const all = [...auto, ...manual].sort(
			(a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)
		);
		return {
			active: all.filter((i) => i.resolvedAt === null),
			recent: all.filter((i) => i.resolvedAt !== null).slice(0, RECENT_INCIDENTS_MAX)
		};
	}
}

interface ExpandedWindow {
	title: string;
	description: string | null;
	/** Config service ids, may contain 'all'. */
	services: string[];
	weekly: string | null;
	start: number;
	end: number;
	entryIdx: number;
	/** Stable id from config when the entry has one. */
	configId: string | null;
}

/**
 * Expand configured maintenance into concrete occurrences. One-shot
 * entries contribute their single window; weekly entries contribute
 * every occurrence between `now - pastMs` and `now + futureMs` so day
 * buckets, active detection, and the upcoming list all share one source.
 */
export function expandWindows(
	cfg: StatusConfig,
	now: number,
	pastMs: number,
	futureMs = UPCOMING_WINDOW_DAYS * DAY_MS
): ExpandedWindow[] {
	const from = now - pastMs;
	const to = now + futureMs;
	const out: ExpandedWindow[] = [];
	cfg.maintenance.forEach((w, entryIdx) => {
		const base = {
			title: w.title,
			description: w.description ?? null,
			services: w.services,
			weekly: w.weekly ?? null,
			entryIdx,
			configId: w.id ?? null
		};
		if (w.weekly && w.at && w.duration_minutes !== undefined) {
			for (const o of weeklyOccurrences(w.weekly, w.at, w.duration_minutes, from, to)) {
				out.push({ ...base, start: o.start, end: o.end });
			}
		} else if (w.start && w.end) {
			out.push({ ...base, start: Date.parse(w.start), end: Date.parse(w.end) });
		}
	});
	return out;
}

function toPublicWindow(w: ExpandedWindow, now: number): MaintenanceWindow {
	return {
		id: w.configId ? `${w.configId}-${w.start}` : `mw-${w.entryIdx}-${w.start}`,
		title: w.title,
		description: w.description,
		services: w.services.includes('all') ? ['*'] : w.services,
		startsAt: new Date(w.start).toISOString(),
		endsAt: new Date(w.end).toISOString(),
		active: w.start <= now && w.end >= now,
		weekly: w.weekly
	};
}
