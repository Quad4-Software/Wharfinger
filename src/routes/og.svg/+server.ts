import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { filterSnapshot } from '$lib/shared/pages';
import { OVERALL_LABEL } from '$lib/shared/status';
import { STATUS_HEX } from '$lib/utils/status-style';

// Generated social card: /og.svg renders a 1200x630 snapshot of the
// site identity plus the live status rollup, and is the default
// og:image (og_image / logo_url overrides win when configured).
// ?page=<slug> scopes the card to a named status page, like favicon.svg.
// Short cache keeps the pill honest without hammering the snapshot.

// Palette mirrors the --color-* tokens in app.css; literals are needed
// because og:image responses cannot reference CSS custom properties.
const BG = '#07090d';
const FG = '#e6edf3';
const MUTED = '#97a3b1';
const FAINT = '#5d6b7a';
const FONT = "Inter, ui-sans-serif, system-ui, 'Segoe UI', sans-serif";

// Lucide anchor glyph, drawn at viewBox 0 0 24 24 stroke scale.
const ANCHOR = `<circle cx="12" cy="5" r="3"/><line x1="12" x2="12" y1="22" y2="8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/>`;

function esc(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function clip(s: string, max: number): string {
	const t = s.trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Greedy word wrap for the description block. The input is pre-clipped
// so overflow always surfaces as the ellipsis on the last line.
function wrap(s: string, width: number, maxLines: number): string[] {
	const words = clip(s, width * maxLines)
		.split(/\s+/)
		.filter(Boolean);
	const lines: string[] = [];
	let cur = '';
	for (const w of words) {
		const cand = cur ? `${cur} ${w}` : w;
		if (cand.length <= width || !cur) {
			cur = cand;
		} else {
			lines.push(cur);
			cur = w;
		}
	}
	if (cur) lines.push(cur);
	return lines.slice(0, maxLines);
}

function hostOf(u: string | null): string {
	if (!u) return '';
	try {
		return new URL(u).host;
	} catch {
		return '';
	}
}

export const GET: RequestHandler = async ({ url }) => {
	const rt = getRuntime();
	const { snapshot } = await rt.snapshot.current();
	const slug = url.searchParams.get('page');
	const meta = slug ? snapshot.pages.find((p) => p.slug === slug) : undefined;
	const snap = meta ? filterSnapshot(snapshot, meta) : snapshot;
	const site = snap.site;
	const statusColor = STATUS_HEX[snap.overall];
	const statusLabel = OVERALL_LABEL[snap.overall];
	// Named pages show their own title/description; the root card uses
	// the og overrides when configured.
	const title = clip(meta ? site.title : (site.ogTitle ?? '') || site.title, 34);
	const descLines = wrap(
		meta ? site.description : (site.ogDescription ?? '') || site.description,
		74,
		2
	);
	const footer = hostOf(site.url) || site.name;
	const accent = site.accent;

	const pillTextW = Math.ceil(statusLabel.length * 12.5);
	const pillW = pillTextW + 74;
	const pillX = 1200 - 80 - pillW;

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${esc(title)}"><rect width="1200" height="630" fill="${BG}"/><rect width="1200" height="6" fill="${accent}"/><circle cx="1120" cy="40" r="360" fill="${accent}" opacity="0.07"/><rect x="80" y="80" width="104" height="104" rx="24" fill="${accent}" fill-opacity="0.12" stroke="${accent}" stroke-opacity="0.45"/><g transform="translate(103 103) scale(2.25)" fill="none" stroke="${accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ANCHOR}</g><g><rect x="${pillX}" y="104" width="${pillW}" height="48" rx="24" fill="${statusColor}" fill-opacity="0.12" stroke="${statusColor}" stroke-opacity="0.45"/><circle cx="${pillX + 30}" cy="128" r="7" fill="${statusColor}"/><text x="${pillX + 48}" y="135" font-family="${FONT}" font-size="22" font-weight="600" fill="${statusColor}">${esc(statusLabel)}</text></g><text x="80" y="330" font-family="${FONT}" font-size="60" font-weight="700" letter-spacing="-1" fill="${FG}">${esc(title)}</text>${descLines
		.map(
			(l, i) =>
				`<text x="80" y="${392 + i * 44}" font-family="${FONT}" font-size="28" fill="${MUTED}">${esc(l)}</text>`
		)
		.join(
			''
		)}<rect x="80" y="492" width="1040" height="1" fill="#ffffff" opacity="0.08"/><text x="80" y="546" font-family="${FONT}" font-size="24" fill="${FAINT}">${esc(footer)}</text><g transform="translate(1060 516) scale(1.75)" fill="none" stroke="${FAINT}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.6">${ANCHOR}</g></svg>`;

	return new Response(svg, {
		headers: {
			'content-type': 'image/svg+xml; charset=utf-8',
			'cache-control': `public, max-age=${Math.min(snapshot.refreshSeconds, 60)}`,
			'content-security-policy': "default-src 'none'; script-src 'none'",
			'x-content-type-options': 'nosniff',
			// Crawlers fetch the card cross-origin.
			'cross-origin-resource-policy': 'cross-origin'
		}
	});
};
