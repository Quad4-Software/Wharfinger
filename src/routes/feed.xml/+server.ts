import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';

export const GET: RequestHandler = async () => {
	const { snapshot } = await getRuntime().snapshot.current();
	const base = snapshot.site.url?.replace(/\/$/, '') ?? '';
	const items = [...snapshot.incidents.active, ...snapshot.incidents.recent]
		.map(
			(i) => `    <item>
      <title>${esc(i.title)}</title>
      <link>${esc(base || '/')}</link>
      <guid isPermaLink="false">${esc(i.id)}</guid>
      <pubDate>${new Date(i.startedAt).toUTCString()}</pubDate>
      <description>${esc(describe(i))}</description>
    </item>`
		)
		.join('\n');

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${esc(snapshot.site.title)}</title>
    <link>${esc(base || '/')}</link>
    <description>${esc(snapshot.site.description)}</description>
${items}
  </channel>
</rss>
`;

	return new Response(xml, {
		headers: {
			'content-type': 'application/rss+xml; charset=utf-8',
			'cache-control': `public, max-age=${snapshot.refreshSeconds}`
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

function describe(i: { severity: string; services: string[]; resolvedAt: string | null }): string {
	const state = i.resolvedAt ? 'resolved' : 'ongoing';
	return `${i.severity} incident (${state}) affecting ${i.services.join(', ')}`;
}
