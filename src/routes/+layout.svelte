<script lang="ts">
	import '@fontsource-variable/inter';
	import '../app.css';
	import { resolve } from '$app/paths';
	import { navigating, page } from '$app/state';
	import type { Snippet } from 'svelte';
	import type { PageMeta, StatusSnapshot } from '$lib/shared/types';
	import { canonicalUrl, jsonLdTag, ogImage, pageDescription, pageTitle } from '$lib/shared/seo';
	import CrashBoundary from '$lib/components/CrashBoundary.svelte';
	import Toasts from '$lib/components/Toasts.svelte';

	const { children }: { children: Snippet } = $props();
	const snapshot = $derived(page.data.snapshot as StatusSnapshot | undefined);
	const meta = $derived((page.data.page as PageMeta | undefined) ?? null);
	const noindex = $derived(Boolean(page.data.noindex) || Boolean(meta?.noindex));

	const site = $derived(snapshot?.site);
	const title = $derived(pageTitle(site, meta));
	const description = $derived(pageDescription(site, meta));
	const canonical = $derived(canonicalUrl(site, page.url.pathname));
	const image = $derived(ogImage(site));
	const ldJson = $derived(jsonLdTag(site, meta, page.url.pathname));
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	<meta name="theme-color" content={site?.accent ?? '#10b981'} />
	{#if canonical}
		<link rel="canonical" href={canonical} />
	{/if}
	<meta property="og:site_name" content={site?.name ?? 'Status'} />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:type" content="website" />
	{#if canonical}
		<meta property="og:url" content={canonical} />
	{/if}
	{#if image}
		<meta property="og:image" content={image} />
	{/if}
	<meta name="twitter:card" content={image ? 'summary_large_image' : 'summary'} />
	<meta name="twitter:title" content={title} />
	<meta name="twitter:description" content={description} />
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
