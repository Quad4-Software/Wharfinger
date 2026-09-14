import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';

export const GET: RequestHandler = () => {
	const rt = getRuntime();
	const { snapshot } = rt.snapshot.current();
	const base = snapshot.site.url?.replace(/\/$/, '');
	const lines = ['User-agent: *', 'Allow: /', 'Disallow: /api/stream'];
	// Only advertise the admin mount when it sits on the default path; a
	// custom base_path is hidden deliberately and relies on x-robots-tag.
	if (rt.adminBase() === '/admin') lines.push('Disallow: /admin');
	// Pages flagged noindex are also disallowed here so crawlers that
	// ignore x-robots-tag never fetch them.
	for (const p of snapshot.pages) {
		if (p.noindex) lines.push(`Disallow: /p/${p.slug}`);
	}
	lines.push('');
	if (base) lines.push(`Sitemap: ${base}/sitemap.xml`);
	return new Response(lines.join('\n'), {
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'public, max-age=3600'
		}
	});
};
