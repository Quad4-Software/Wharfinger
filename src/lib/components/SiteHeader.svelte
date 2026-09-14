<script lang="ts">
	import { resolve } from '$app/paths';
	import { Activity, Rss } from '@lucide/svelte';
	import type { PageMeta, StatusSnapshot } from '$lib/shared/types';

	const {
		site,
		pages = [],
		currentSlug = null
	}: { site: StatusSnapshot['site']; pages?: PageMeta[]; currentSlug?: string | null } = $props();
</script>

<header class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-6">
	<div class="flex items-center gap-3">
		{#if site.logoUrl}
			<img
				src={site.logoUrl}
				alt=""
				width="36"
				height="36"
				class="size-9 rounded-lg object-contain ring-1 ring-edge"
			/>
		{:else}
			<div
				class="flex size-9 items-center justify-center rounded-lg ring-1 ring-edge"
				style="background: color-mix(in srgb, var(--color-accent) 14%, transparent)"
			>
				<Activity class="size-5 text-accent" strokeWidth={2.2} />
			</div>
		{/if}
		<div>
			<div class="text-[15px] font-semibold tracking-tight text-fg">{site.name}</div>
			<div class="text-xs text-muted">Status</div>
		</div>
	</div>

	<nav class="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 text-sm">
		{#if pages.length > 0}
			<a
				href={resolve('/')}
				class="transition-colors {currentSlug === null ? 'text-fg' : 'text-muted hover:text-fg'}"
				>All</a
			>
			{#each pages as p (p.slug)}
				<a
					href={resolve('/p/[slug]', { slug: p.slug })}
					class="transition-colors {currentSlug === p.slug
						? 'text-fg'
						: 'text-muted hover:text-fg'}">{p.title}</a
				>
			{/each}
			<span class="h-4 w-px bg-edge" aria-hidden="true"></span>
		{/if}
		{#each site.links as link (link.href)}
			<a
				href={link.href}
				class="text-muted transition-colors hover:text-fg"
				target="_blank"
				rel="external noopener noreferrer">{link.label}</a
			>
		{/each}
		<a
			href={resolve('/feed.xml')}
			class="inline-flex items-center gap-1.5 text-muted transition-colors hover:text-fg"
			title="RSS incident feed"
		>
			<Rss class="size-4" />
			<span class="hidden sm:inline">Feed</span>
		</a>
	</nav>
</header>
