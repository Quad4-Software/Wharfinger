<script lang="ts">
	import type { Snippet } from 'svelte';

	const {
		title,
		description = null,
		children
	}: {
		title: string;
		description?: string | null;
		children?: Snippet;
	} = $props();
</script>

<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
	<div>
		<h1 class="text-xl font-semibold tracking-tight">{title}</h1>
		{#if description}<p class="mt-1 text-sm text-muted">{description}</p>{/if}
	</div>
	{#if children}
		<div class="flex items-center gap-2">{@render children()}</div>
	{/if}
</div>
