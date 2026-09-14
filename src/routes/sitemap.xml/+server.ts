import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';

export const GET: RequestHandler = () => {
	const { snapshot } = getRuntime().snapshot.current();
	const base = snapshot.site.url?.replace(/\/+$/, '');
	// Without a canonical site.url a sitemap would be guesswork.
	if (!base) return new Response('site.url is not configured', { status: 404 });

	const urls = [
		'/',
		// noindex pages are excluded, matching robots.txt and the meta tag.
		...snapshot.pages.filter((p) => !p.noindex).map((p) => `/p/${p.slug}`)
	];
	const lastmod = snapshot.generatedAt.slice(0, 10);
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(base + u)}</loc><lastmod>${lastmod}</lastmod></url>`).join('\n')}
</urlset>
`;

	return new Response(xml, {
		headers: {
			'content-type': 'application/xml; charset=utf-8',
			'cache-control': `public, max-age=${Math.max(snapshot.refreshSeconds, 300)}`
		}
	});
};

function esc(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
