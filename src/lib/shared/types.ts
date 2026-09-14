import type { DayState, ServiceStatus } from './status';
import type { GroupRef } from './groups';

// Wire types for the public status snapshot served by GET /api/status and
// pushed over /api/stream. Everything the page renders derives from this.

export interface DayBucket {
	/** ISO date, YYYY-MM-DD, in the configured display timezone. */
	date: string;
	state: DayState;
	/** 0-100, null when there is no data for the day. */
	uptime: number | null;
	/** Number of checks that ran that day. */
	checks: number;
}

export interface LatencyPoint {
	/** Unix ms, bucket start. */
	t: number;
	/** Null when the bucket has no samples; charts should render a gap. */
	avg: number | null;
	max: number | null;
	min: number | null;
}

export interface ServiceSnapshot {
	id: string;
	name: string;
	description: string | null;
	status: ServiceStatus;
	/** Latest observed latency in ms, null before first check. */
	latencyMs: number | null;
	/** Uptime percentages for fixed trailing windows. */
	uptime: { d24: number | null; d7: number | null; d30: number | null; d90: number | null };
	/** Latency buckets for the last 24 hours. */
	latency: LatencyPoint[];
	/** Deployment/release markers inside the latency window. */
	markers?: { ts: number; title: string; kind: string }[];
	/** SLO status when a target is configured for this service. */
	slo?: {
		target: number;
		windowDays: number;
		/** Uptime ratio over the window (0-1), null without data. */
		uptime: number | null;
		/** Fraction of error budget remaining (0-1), null without data. */
		budgetRemaining: number | null;
		/** Recent burn rate vs the allowed error rate; >1 is too fast. */
		burnRate: number | null;
	};
	/** Daily buckets, oldest first, length = history_days. */
	days: DayBucket[];
	/** True while a configured maintenance window covers the service. */
	inMaintenance: boolean;
	/** Timestamp of last completed check, unix ms. */
	lastCheckedAt: number | null;
	/** Detail string from the last check, e.g. "HTTP 200". */
	lastDetail: string | null;
	/** Days until TLS cert expiry, null when not TLS monitored. */
	certDays: number | null;
	/** True when the cert is inside the configured warn window. */
	certWarn: boolean;
	/** Cached favicon URL, or null to render the letter fallback. */
	icon: string | null;
	/** Service group ids this service belongs to; used for filtering. */
	groupIds: string[];
}

export interface GroupSnapshot {
	name: string;
	services: ServiceSnapshot[];
}

type IncidentSeverity = 'minor' | 'major' | 'maintenance';

interface IncidentUpdate {
	at: string;
	message: string;
}

export interface Incident {
	id: string;
	title: string;
	severity: IncidentSeverity;
	services: string[];
	startedAt: string;
	resolvedAt: string | null;
	updates: IncidentUpdate[];
	/** Manual incidents come from TOML, auto ones from the monitor. */
	source: 'auto' | 'manual';
}

export interface MaintenanceWindow {
	id: string;
	title: string;
	description: string | null;
	services: string[];
	startsAt: string;
	endsAt: string;
	active: boolean;
	/** Weekday for recurring windows, e.g. 'tue'; null for one-shot. */
	weekly: string | null;
}

/**
 * A named status page served at /p/<slug>. The page projects the full
 * snapshot down to its own service list; services = ['*'] means all.
 */
export interface PageMeta {
	slug: string;
	title: string;
	description: string | null;
	accent: string | null;
	services: string[];
	/** True when the page asks crawlers to stay out. */
	noindex?: boolean;
}

export interface StatusSnapshot {
	generatedAt: string;
	site: {
		name: string;
		title: string;
		description: string;
		url: string | null;
		/** Configured logo URL, absolute or root-relative; null when unset. */
		logoUrl: string | null;
		accent: string;
		announcement: { text: string; severity: 'info' | 'warning' | 'critical' } | null;
		links: { label: string; href: string }[];
	};
	overall: ServiceStatus;
	groups: GroupSnapshot[];
	incidents: { active: Incident[]; recent: Incident[] };
	maintenance: { active: MaintenanceWindow[]; upcoming: MaintenanceWindow[] };
	/** Extra status pages configured via [[pages]]; empty when none. */
	pages: PageMeta[];
	/** Admin-managed service groups; names/colors for filter chips. */
	serviceGroups: GroupRef[];
	historyDays: number;
	refreshSeconds: number;
}
