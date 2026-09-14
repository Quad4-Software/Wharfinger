import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';

// Prometheus text exposition built from the public snapshot. Exposes
// only data already public via /api/status; scrape targets just add
// this URL. Labels escape the three chars the format requires.

const esc = (s: string): string =>
	s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

const STATUS_VALUE: Record<string, number> = {
	operational: 1,
	maintenance: 1,
	degraded: 0.5,
	partial_outage: 0.25,
	major_outage: 0,
	unknown: -1
};

export const GET: RequestHandler = () => {
	const snap = getRuntime().snapshot.current().snapshot;

	const lines: string[] = [];
	const metric = (
		name: string,
		help: string,
		type: string,
		fn: (push: (labels: Record<string, string>, value: number) => void) => void
	) => {
		lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
		fn((labels, value) => {
			const l = Object.entries(labels)
				.map(([k, v]) => `${k}="${esc(v)}"`)
				.join(',');
			lines.push(`${name}${l ? `{${l}}` : ''} ${value}`);
		});
	};

	metric(
		'wharfinger_service_status',
		'Service status (1 up, 0.5 degraded, 0 down, -1 unknown).',
		'gauge',
		(push) => {
			for (const g of snap.groups)
				for (const s of g.services)
					push({ service: s.name, group: g.name }, STATUS_VALUE[s.status] ?? -1);
		}
	);

	metric(
		'wharfinger_service_uptime_ratio',
		'Service uptime ratio over the labelled range.',
		'gauge',
		(push) => {
			for (const g of snap.groups)
				for (const s of g.services)
					for (const [range, v] of Object.entries(s.uptime))
						if (v !== null) push({ service: s.name, group: g.name, range }, v / 100);
		}
	);

	metric(
		'wharfinger_service_latency_ms',
		'Last successful check latency in milliseconds.',
		'gauge',
		(push) => {
			for (const g of snap.groups)
				for (const s of g.services)
					if (s.latencyMs !== null) push({ service: s.name, group: g.name }, s.latencyMs);
		}
	);

	metric(
		'wharfinger_service_cert_days_remaining',
		'Days until the TLS certificate expires.',
		'gauge',
		(push) => {
			for (const g of snap.groups)
				for (const s of g.services) if (s.certDays !== null) push({ service: s.name }, s.certDays);
		}
	);

	metric(
		'wharfinger_overall_status',
		'Overall status (1 up, 0.5 degraded, 0 down).',
		'gauge',
		(push) => {
			push({}, STATUS_VALUE[snap.overall] ?? -1);
		}
	);

	metric('wharfinger_incidents_active', 'Incidents without a resolution.', 'gauge', (push) => {
		push({}, snap.incidents.active.length);
	});

	metric(
		'wharfinger_maintenance_active',
		'Maintenance windows currently in effect.',
		'gauge',
		(push) => {
			push({}, snap.maintenance.active.length);
		}
	);

	return new Response(lines.join('\n') + '\n', {
		headers: {
			'content-type': 'text/plain; version=0.0.4; charset=utf-8',
			'cache-control': 'no-store'
		}
	});
};
