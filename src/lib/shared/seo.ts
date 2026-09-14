import type { PageMeta, StatusSnapshot } from './types';

// Head metadata helpers shared by the root layout. Everything derives
// from the snapshot so meta stays in sync with what the page renders.

type Site = StatusSnapshot['site'];

export function pageTitle(site: Site | undefined, meta: PageMeta | null | undefined): string {
	// Named pages arrive as a filtered snapshot whose site.title is
	// already the page title, so site.name is the only stable suffix.
	if (meta) return `${meta.title} · ${site?.name ?? 'Status'}`;
	return site?.title ?? 'Status';
}

export function pageDescription(site: Site | undefined, meta: PageMeta | null | undefined): string {
	return meta?.description ?? site?.description ?? 'Service status';
}

/** Canonical URL for the current path, or null when site.url is unset. */
export function canonicalUrl(site: Site | undefined, path: string): string | null {
	const base = site?.url?.replace(/\/+$/, '');
	return base ? `${base}${path}` : null;
}

/**
 * Absolute og:image. logo_url may be a root-relative path, which only
 * works for social crawlers once resolved against site.url.
 */
export function ogImage(site: Site | undefined): string | null {
	const logo = site?.logoUrl;
	if (!logo) return null;
	if (logo.startsWith('http://') || logo.startsWith('https://')) return logo;
	const base = site.url?.replace(/\/+$/, '');
	if (!base) return null;
	return `${base}${logo.startsWith('/') ? '' : '/'}${logo}`;
}

interface JsonLdSite {
	'@type': 'WebSite';
	name: string;
	url?: string;
	description?: string;
}

/**
 * Schema.org JSON-LD for the document, returned as a complete script
 * tag for {@html} injection. The root page declares a WebSite; named
 * pages declare a WebPage linked back to it. The serialized output
 * escapes < so it is safe inside a script tag.
 */
export function jsonLdTag(
	site: Site | undefined,
	meta: PageMeta | null | undefined,
	path: string
): string | null {
	if (!site) return null;
	const base = site.url?.replace(/\/+$/, '');
	const website: JsonLdSite = {
		'@type': 'WebSite',
		name: site.title,
		...(base ? { url: base } : {}),
		...(site.description ? { description: site.description } : {})
	};
	const doc: Record<string, unknown> = meta
		? {
				'@context': 'https://schema.org',
				'@type': 'WebPage',
				name: pageTitle(site, meta),
				description: pageDescription(site, meta),
				...(base ? { url: `${base}${path}` } : {}),
				isPartOf: website
			}
		: { '@context': 'https://schema.org', ...website };
	const json = JSON.stringify(doc).replace(/</g, '\\u003c');
	return `<script type="application/ld+json">${json}</script>`;
}
