<script lang="ts">
	import type { Snippet } from 'svelte';

	const {
		label,
		hint = null,
		required = false,
		children
	}: {
		label: string;
		hint?: string | null;
		required?: boolean;
		children: Snippet;
	} = $props();
</script>

<label class="block">
	<span class="mb-1.5 flex items-baseline gap-1.5 text-sm font-medium text-fg">
		{label}
		{#if required}<span class="text-down-fg" aria-hidden="true">*</span>{/if}
	</span>
	{@render children()}
	{#if hint}
		<span class="mt-1 block text-xs leading-relaxed text-faint">{hint}</span>
	{/if}
</label>
