<script lang="ts">
	import '@fontsource-variable/inter';
	import '../app.css';
	import { resolve } from '$app/paths';
	import { navigating, page } from '$app/state';
	import type { Snippet } from 'svelte';
	import type { PageMeta, StatusSnapshot } from '$lib/shared/types';
	import {
		canonicalUrl,
		jsonLdTag,
		ogDescription,
		ogImage,
		ogTitle,
		pageDescription,
		pageTitle
	} from '$lib/shared/seo';
	import CrashBoundary from '$lib/components/CrashBoundary.svelte';
	import Toasts from '$lib/components/Toasts.svelte';
	import { initLocale, syncClientLocale } from '$lib/i18n/locale.svelte';

	const { children }: { children: Snippet } = $props();

	// Runs synchronously at the top of every SSR render and hydration,
	// which is what makes the shared module state safe per request.
	initLocale(page.data.lang as string | undefined);
	$effect(() => {
		syncClientLocale();
	});

	const snapshot = $derived(page.data.snapshot as StatusSnapshot | undefined);
	const meta = $derived((page.data.page as PageMeta | undefined) ?? null);
	const site = $derived(snapshot?.site);
	const noindex = $derived(
		Boolean(page.data.noindex) || Boolean(meta?.noindex) || site?.robots === 'noindex'
	);

	const title = $derived(pageTitle(site, meta));
	const description = $derived(pageDescription(site, meta));
	const cardTitle = $derived(ogTitle(site, meta));
	const cardDescription = $derived(ogDescription(site, meta));
	const canonical = $derived(canonicalUrl(site, page.url.pathname));
	const image = $derived(ogImage(site, meta?.slug ?? null));
	const ldJson = $derived(jsonLdTag(site, meta, page.url.pathname));
	// Status-colored favicon; named pages scope the dot to their rollup.
	const favicon = $derived(meta ? `/favicon.svg?page=${meta.slug}` : '/favicon.svg');
</script>

<svelte:head>
	<title>{title}</title>
	<link rel="icon" type="image/svg+xml" href={favicon} />
	<meta name="description" content={description} />
	<meta name="theme-color" content={site?.accent ?? '#d9a648'} />
	{#if canonical}
		<link rel="canonical" href={canonical} />
	{/if}
	<meta property="og:site_name" content={site?.name ?? 'Status'} />
	<meta property="og:title" content={cardTitle} />
	<meta property="og:description" content={cardDescription} />
	<meta property="og:type" content="website" />
	{#if canonical}
		<meta property="og:url" content={canonical} />
	{/if}
	{#if image}
		<meta property="og:image" content={image} />
	{/if}
	<meta name="twitter:card" content={image ? 'summary_large_image' : 'summary'} />
	{#if site?.twitterSite}
		<meta name="twitter:site" content={site.twitterSite} />
	{/if}
	<meta name="twitter:title" content={cardTitle} />
	<meta name="twitter:description" content={cardDescription} />
	{#if image}
		<meta name="twitter:image" content={image} />
	{/if}
	<link
		rel="alternate"
		type="application/rss+xml"
		title="{site?.title ?? 'Status'} incidents"
		href={resolve('/feed.xml')}
	/>
	{#if noindex}
		<meta name="robots" content="noindex, nofollow, noarchive" />
	{:else}
		<meta name="robots" content="index, follow" />
	{/if}
	{#if ldJson}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- JSON-LD is escaped by jsonLdTag -->
		{@html ldJson}
	{/if}
</svelte:head>

{#if navigating.to}
	<div class="fixed inset-x-0 top-0 z-[90] h-0.5 animate-pulse bg-accent" aria-hidden="true"></div>
{/if}

<CrashBoundary>
	{@render children()}
</CrashBoundary>
<Toasts />
