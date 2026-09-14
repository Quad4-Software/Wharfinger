<script lang="ts">
	// Horizontal usage bar with semantic threshold colors.
	const {
		pct,
		label = '',
		detail = '',
		compact = false
	}: { pct: number; label?: string; detail?: string; compact?: boolean } = $props();

	const clamped = $derived(Math.max(0, Math.min(100, pct)));
	const tone = $derived(clamped >= 90 ? 'bg-down' : clamped >= 75 ? 'bg-degraded' : 'bg-accent');
</script>

<div class={compact ? 'space-y-0.5' : 'space-y-1'}>
	{#if label || detail}
		<div class="flex items-baseline justify-between gap-2 text-xs">
			<span class="truncate text-muted">{label}</span>
			{#if detail}<span class="shrink-0 font-mono text-faint">{detail}</span>{/if}
		</div>
	{/if}
	<div
		class="h-1.5 w-full overflow-hidden rounded-full bg-edge/60"
		role="meter"
		aria-valuenow={Math.round(clamped)}
		aria-valuemin={0}
		aria-valuemax={100}
		aria-label={label || 'usage'}
	>
		<div
			class="h-full rounded-full {tone} transition-[width] duration-500"
			style="width:{clamped}%"
		></div>
	</div>
</div>
