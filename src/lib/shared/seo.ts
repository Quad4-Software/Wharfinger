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
 * og:title and og:description honor the site-level overrides on the
 * root page; named pages keep their own title/description so shared
 * links stay specific to the page.
 */
export function ogTitle(site: Site | undefined, meta: PageMeta | null | undefined): string {
	return meta ? pageTitle(site, meta) : (site?.ogTitle ?? '') || pageTitle(site, meta);
}

export function ogDescription(site: Site | undefined, meta: PageMeta | null | undefined): string {
	return meta
		? pageDescription(site, meta)
		: (site?.ogDescription ?? '') || pageDescription(site, meta);
}

/**
 * Absolute og:image: the og_image override first, then the generated
 * /og.svg card (scoped to a named page via ?page=), then logo_url.
 * Root-relative sources only work for crawlers once resolved against
 * site.url, so everything returns null when it is unset.
 */
export function ogImage(site: Site | undefined, page?: string | null): string | null {
	const base = site?.url?.replace(/\/+$/, '');
	const override = site?.ogImage;
	if (override) {
		if (override.startsWith('https://')) return override;
		if (base) return `${base}${override.startsWith('/') ? '' : '/'}${override}`;
	}
	if (base) return `${base}/og.svg${page ? `?page=${encodeURIComponent(page)}` : ''}`;
	const logo = site?.logoUrl;
	return logo && /^https?:\/\//.test(logo) ? logo : null;
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
