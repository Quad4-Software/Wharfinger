// Service health states. SEVERITY_RANK orders them for the worst-of
// overall page rollup.
export type ServiceStatus =
	'operational' | 'maintenance' | 'degraded' | 'partial_outage' | 'major_outage' | 'unknown';

const SEVERITY_RANK: Record<ServiceStatus, number> = {
	operational: 0,
	maintenance: 1,
	degraded: 2,
	partial_outage: 3,
	major_outage: 4,
	unknown: -1
};

export function worstStatus(statuses: Iterable<ServiceStatus>): ServiceStatus {
	let worst: ServiceStatus = 'operational';
	let sawAny = false;
	for (const s of statuses) {
		if (s === 'unknown') continue;
		sawAny = true;
		if (SEVERITY_RANK[s] > SEVERITY_RANK[worst]) worst = s;
	}
	return sawAny ? worst : 'unknown';
}

export const STATUS_LABEL: Record<ServiceStatus, string> = {
	operational: 'Operational',
	maintenance: 'Maintenance',
	degraded: 'Degraded',
	partial_outage: 'Partial Outage',
	major_outage: 'Major Outage',
	unknown: 'Unknown'
};

export const OVERALL_LABEL: Record<ServiceStatus, string> = {
	operational: 'All Systems Operational',
	maintenance: 'Scheduled Maintenance',
	degraded: 'Degraded Performance',
	partial_outage: 'Partial Service Disruption',
	major_outage: 'Major Service Outage',
	unknown: 'Status Unknown'
};

// Daily uptime bar buckets.
export type DayState = 'up' | 'degraded' | 'down' | 'maintenance' | 'nodata';

export function classifyDay(upFraction: number | null): DayState {
	if (upFraction === null) return 'nodata';
	if (upFraction >= 0.999) return 'up';
	if (upFraction >= 0.9) return 'degraded';
	return 'down';
}
