import type { ServiceStatus } from '$lib/shared/status';

// Hex values mirror the --color-* tokens in app.css. They exist as
// literals because server-rendered SVG badges and inline accent styles
// cannot reference Tailwind utilities.
export const STATUS_HEX: Record<ServiceStatus, string> = {
	operational: '#34d399',
	maintenance: '#38bdf8',
	degraded: '#fbbf24',
	partial_outage: '#fb923c',
	major_outage: '#f43f5e',
	unknown: '#3f4a5a'
};

export const STATUS_PILL: Record<ServiceStatus, string> = {
	operational: 'bg-up/10 text-up-fg ring-up/30',
	maintenance: 'bg-maint/10 text-maint-fg ring-maint/30',
	degraded: 'bg-degraded/10 text-degraded-fg ring-degraded/30',
	partial_outage: 'bg-partial/10 text-partial-fg ring-partial/30',
	major_outage: 'bg-down/10 text-down-fg ring-down/40',
	unknown: 'bg-nodata/10 text-nodata-fg ring-nodata/30'
};

export const DAY_CLASS: Record<string, string> = {
	up: 'bg-up/90',
	degraded: 'bg-degraded/90',
	down: 'bg-down/90',
	maintenance: 'bg-maint/90',
	nodata: 'bg-nodata/60'
};

export const DAY_LABEL: Record<string, string> = {
	up: 'Operational',
	degraded: 'Partial disruption',
	down: 'Major disruption',
	maintenance: 'Maintenance',
	nodata: 'No data'
};
