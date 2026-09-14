import { describe, expect, it } from 'vitest';
import { canonicalUrl, jsonLdTag, ogImage, pageDescription, pageTitle } from '$lib/shared/seo';
import type { PageMeta, StatusSnapshot } from '$lib/shared/types';

const site = {
	name: 'Quad4',
	title: 'Quad4 Status',
	description: 'Live uptime.',
	url: 'https://status.quad4.io/',
	logoUrl: '/logo.svg',
	accent: '#10b981',
	announcement: null,
	links: []
} satisfies StatusSnapshot['site'];

const meta = {
	slug: 'projects',
	title: 'Projects',
	description: 'Project services.',
	accent: null,
	services: ['*'],
	noindex: false
} satisfies PageMeta;

describe('pageTitle/pageDescription', () => {
	it('combines page title and site name', () => {
		expect(pageTitle(site, meta)).toBe('Projects · Quad4');
		expect(pageTitle(site, null)).toBe('Quad4 Status');
		expect(pageTitle(undefined, null)).toBe('Status');
		// Filtered snapshots carry the page title in site.title; the
		// name suffix must not double it.
		expect(pageTitle({ ...site, title: 'Projects' }, meta)).toBe('Projects · Quad4');
	});

	it('prefers the page description', () => {
		expect(pageDescription(site, meta)).toBe('Project services.');
		expect(pageDescription(site, null)).toBe('Live uptime.');
		expect(pageDescription(undefined, null)).toBe('Service status');
	});
});

describe('canonicalUrl', () => {
	it('joins site url and path without a double slash', () => {
		expect(canonicalUrl(site, '/p/projects')).toBe('https://status.quad4.io/p/projects');
	});

	it('is null without site.url', () => {
		expect(canonicalUrl({ ...site, url: null }, '/')).toBeNull();
		expect(canonicalUrl(undefined, '/')).toBeNull();
	});
});

describe('ogImage', () => {
	it('resolves root-relative logos against site.url', () => {
		expect(ogImage(site)).toBe('https://status.quad4.io/logo.svg');
	});

	it('passes absolute logos through and drops relative ones without site.url', () => {
		expect(ogImage({ ...site, logoUrl: 'https://cdn.io/l.png' })).toBe('https://cdn.io/l.png');
		expect(ogImage({ ...site, url: null })).toBeNull();
		expect(ogImage({ ...site, logoUrl: null })).toBeNull();
	});
});

describe('jsonLdTag', () => {
	function doc(site: StatusSnapshot['site'], meta: PageMeta | null, path: string) {
		const tag = jsonLdTag(site, meta, path)!;
		const inner = tag.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
		return JSON.parse(inner) as Record<string, unknown>;
	}

	it('declares a WebSite on the root page', () => {
		const d = doc(site, null, '/');
		expect(d['@type']).toBe('WebSite');
		expect(d.url).toBe('https://status.quad4.io');
	});

	it('declares a WebPage linked to the WebSite on named pages', () => {
		const d = doc(site, meta, '/p/projects');
		expect(d['@type']).toBe('WebPage');
		expect(d.url).toBe('https://status.quad4.io/p/projects');
		expect((d.isPartOf as Record<string, unknown>)['@type']).toBe('WebSite');
	});

	it('escapes closing tags in the serialized output', () => {
		const out = jsonLdTag({ ...site, description: 'a</script><b>' }, null, '/')!;
		expect(out).not.toContain('</script><b>');
	});
});
