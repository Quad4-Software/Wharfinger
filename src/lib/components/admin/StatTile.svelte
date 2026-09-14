<script lang="ts">
	import type { Snippet } from 'svelte';

	// Small KPI card used on the systems dashboard and detail pages.
	const {
		label,
		value,
		sub = '',
		icon,
		tone = 'default'
	}: {
		label: string;
		value: string;
		sub?: string;
		icon?: Snippet;
		tone?: 'default' | 'ok' | 'warn' | 'bad';
	} = $props();

	const tones = {
		default: 'text-fg',
		ok: 'text-up',
		warn: 'text-degraded',
		bad: 'text-down'
	};
</script>

<div class="card px-4 py-3">
	<div class="flex items-center justify-between gap-2">
		<span class="text-xs font-medium uppercase tracking-wide text-faint">{label}</span>
		{#if icon}<span class="text-faint">{@render icon()}</span>{/if}
	</div>
	<div class="mt-1 truncate text-lg font-semibold tabular-nums {tones[tone]}">{value}</div>
	{#if sub}<div class="truncate text-xs text-muted">{sub}</div>{/if}
</div>
