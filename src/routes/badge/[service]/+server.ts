import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { STATUS_LABEL, type ServiceStatus } from '$lib/shared/status';

// Embeddable shields-style badge: /badge/<service-id>.svg
//   ?metric=status|uptime|latency   value to show (default status)
//   ?range=24h|7d|30d|90d           uptime window (default 24h)
//   ?style=flat|flat-square|for-the-badge|plastic
//   ?label=text                     custom left label
//   ?color=%23rrggbb                value color override
//   ?labelColor=%23rrggbb           label color override
const COLORS: Record<ServiceStatus | 'unknown', string> = {
	operational: '#10b981',
	maintenance: '#3b82f6',
	degraded: '#f59e0b',
	partial_outage: '#f97316',
	major_outage: '#ef4444',
	unknown: '#6b7280'
};

const LABEL_BG = '#1f2937';
const HEX = /^#[0-9a-f]{3,8}$/i;
const UPTIME_KEYS = { '24h': 'd24', '7d': 'd7', '30d': 'd30', '90d': 'd90' } as const;

// Width estimate per char at the given size for Verdana-ish fonts.
function textWidth(s: string, size: number): number {
	return Math.ceil(s.length * size * 0.62) + 10;
}

export const GET: RequestHandler = ({ params, url }) => {
	const { snapshot } = getRuntime().snapshot.current();
	const id = params.service.replace(/\.svg$/, '');
	const svc = snapshot.groups.flatMap((g) => g.services).find((s) => s.id === id);
	if (!svc) return new Response('unknown service', { status: 404 });

	const metric = url.searchParams.get('metric') ?? 'status';
	const style = url.searchParams.get('style') ?? 'flat';
	if (!['flat', 'flat-square', 'for-the-badge', 'plastic'].includes(style)) {
		return new Response('unknown style', { status: 422 });
	}

	const label = url.searchParams.get('label')?.slice(0, 60) ?? svc.name;
	let value: string;
	let color = COLORS[svc.status];
	if (metric === 'uptime') {
		const key =
			(UPTIME_KEYS as Record<string, 'd24' | 'd7' | 'd30' | 'd90' | undefined>)[
				url.searchParams.get('range') ?? ''
			] ?? 'd24';
		const u = svc.uptime[key];
		value = u === null ? 'no data' : `${u.toFixed(u >= 99.995 ? 3 : 2)}%`;
		if (u !== null)
			color =
				u >= 99.9
					? COLORS.operational
					: u >= 99
						? '#84cc16'
						: u >= 97
							? COLORS.degraded
							: COLORS.major_outage;
	} else if (metric === 'latency') {
		value = svc.latencyMs === null ? 'n/a' : `${Math.round(svc.latencyMs)} ms`;
	} else if (metric === 'status') {
		value = STATUS_LABEL[svc.status];
	} else {
		return new Response('unknown metric', { status: 422 });
	}

	// User color overrides: hex-only, validated, so nothing injects markup.
	const colorParam = url.searchParams.get('color');
	const labelColorParam = url.searchParams.get('labelColor');
	if (colorParam && HEX.test(colorParam)) color = colorParam;
	const labelBg = labelColorParam && HEX.test(labelColorParam) ? labelColorParam : LABEL_BG;

	const badge =
		style === 'for-the-badge'
			? forTheBadge(label, value, labelBg, color)
			: flatBadge(label, value, labelBg, color, style);

	return new Response(badge, {
		headers: {
			'content-type': 'image/svg+xml; charset=utf-8',
			'cache-control': `public, max-age=${Math.min(snapshot.refreshSeconds, 60)}`,
			'access-control-allow-origin': '*'
		}
	});
};

function flatBadge(
	label: string,
	value: string,
	labelBg: string,
	color: string,
	style: string
): string {
	const h = 20;
	const rx = style === 'flat-square' ? 0 : 3;
	const lw = textWidth(label, 11);
	const vw = textWidth(value, 11);
	const gradient =
		style === 'plastic'
			? `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".7"/><stop offset=".1" stop-color="#aaa" stop-opacity=".1"/><stop offset=".9" stop-opacity=".3"/><stop offset="1" stop-opacity=".5"/></linearGradient>`
			: '';
	const overlay =
		style === 'plastic' ? `<rect width="${lw + vw}" height="${h}" rx="${rx}" fill="url(#s)"/>` : '';
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="${h}" role="img" aria-label="${esc(label)}: ${esc(value)}"><title>${esc(label)}: ${esc(value)}</title>${gradient}<rect width="${lw}" height="${h}" rx="${rx}" fill="${esc(labelBg)}"/><rect x="${lw}" width="${vw}" height="${h}" rx="${rx}" fill="${esc(color)}"/><rect x="${lw}" width="4" height="${h}" fill="${esc(color)}"/>${overlay}<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle"><text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`;
}

function forTheBadge(label: string, value: string, labelBg: string, color: string): string {
	const h = 28;
	const up = (s: string) => s.toUpperCase();
	const lw = textWidth(up(label), 10);
	const vw = textWidth(up(value), 10);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="${h}" role="img" aria-label="${esc(label)}: ${esc(value)}"><title>${esc(label)}: ${esc(value)}</title><rect width="${lw}" height="${h}" fill="${esc(labelBg)}"/><rect x="${lw}" width="${vw}" height="${h}" fill="${esc(color)}"/><g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="10" font-weight="bold" letter-spacing="1" text-anchor="middle"><text x="${lw / 2}" y="19">${esc(up(label))}</text><text x="${lw + vw / 2}" y="19">${esc(up(value))}</text></g></svg>`;
}

function esc(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
