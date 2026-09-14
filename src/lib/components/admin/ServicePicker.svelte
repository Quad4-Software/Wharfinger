<script lang="ts">
	// Chip multi-select over the configured service ids, plus 'all'.
	let {
		services,
		selected = $bindable<string[]>([]),
		allowAll = true
	}: {
		services: { id: string; name: string }[];
		selected?: string[];
		allowAll?: boolean;
	} = $props();

	const allOn = $derived(selected.includes('all'));

	function toggle(id: string): void {
		if (id === 'all') {
			selected = allOn ? [] : ['all'];
			return;
		}
		const next = selected.filter((s) => s !== 'all' && s !== id);
		if (!selected.includes(id)) next.push(id);
		selected = next;
	}
</script>

<div class="flex flex-wrap gap-1.5">
	{#if allowAll}
		<button
			type="button"
			class="chip {allOn ? 'chip-on' : ''} cursor-pointer py-1"
			onclick={() => {
				toggle('all');
			}}
		>
			All services
		</button>
	{/if}
	{#each services as s (s.id)}
		<button
			type="button"
			class="chip {!allOn && selected.includes(s.id) ? 'chip-on' : ''} cursor-pointer py-1"
			onclick={() => {
				toggle(s.id);
			}}
			disabled={allOn}
		>
			{s.name}
		</button>
	{/each}
</div>
{#if !allOn && selected.length === 0}
	<p class="mt-1 text-xs text-degraded-fg">Select at least one service</p>
{/if}
