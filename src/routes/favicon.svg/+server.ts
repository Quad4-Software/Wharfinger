import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { filterSnapshot } from '$lib/shared/pages';
import { STATUS_HEX } from '$lib/utils/status-style';
import type { ServiceStatus } from '$lib/shared/status';

// Anchor path from the Lucide icon set (ISC), stroked in the current
// status color over a dark tile so the tab mark reads on light and
// dark browser chrome. ?page=<slug> scopes the color to a named page.
const ANCHOR =
	'M12 6v16 M19 13l2-1a9 9 0 0 1-18 0l2 1 M9 11h6' + ' M12 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z';

export const GET: RequestHandler = async ({ url }) => {
	const rt = getRuntime();
	const { snapshot } = await rt.snapshot.current();
	let status: ServiceStatus = snapshot.overall;
	const slug = url.searchParams.get('page');
	if (slug) {
		const meta = snapshot.pages.find((p) => p.slug === slug);
		if (meta) status = filterSnapshot(snapshot, meta).overall;
	}
	const color = STATUS_HEX[status];
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
		`<rect width="24" height="24" rx="5" fill="#0c1016"/>` +
		`<path d="${ANCHOR}" fill="none" stroke="${color}" stroke-width="2.1" ` +
		`stroke-linecap="round" stroke-linejoin="round"/></svg>`;
	return new Response(svg, {
		headers: {
			'content-type': 'image/svg+xml; charset=utf-8',
			'cache-control': `public, max-age=${Math.min(snapshot.refreshSeconds, 60)}`,
			'content-security-policy': "default-src 'none'; script-src 'none'",
			'x-content-type-options': 'nosniff'
		}
	});
};
