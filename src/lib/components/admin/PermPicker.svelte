<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';

	// Permission editor: toggle chips grouped by namespace (users.*,
	// status.*, ...) instead of a wall of native checkboxes. Each chip
	// shows the suffix and carries the full name in the tooltip.
	let {
		permissions,
		selected = $bindable([]),
		disabled = false
	}: {
		permissions: string[];
		selected?: string[];
		disabled?: boolean;
	} = $props();

	interface PermGroup {
		prefix: string;
		perms: string[];
	}

	const groups = $derived.by((): PermGroup[] => {
		const map = new SvelteMap<string, string[]>();
		for (const p of permissions) {
			const prefix = p.includes('.') ? p.slice(0, p.indexOf('.')) : p;
			const list = map.get(prefix) ?? [];
			list.push(p);
			map.set(prefix, list);
		}
		return [...map.entries()].map(([prefix, perms]) => ({ prefix, perms }));
	});

	function suffix(p: string): string {
		return p.includes('.') ? p.slice(p.indexOf('.') + 1) : p;
	}

	function toggle(p: string): void {
		if (disabled) return;
		selected = selected.includes(p) ? selected.filter((x) => x !== p) : [...selected, p];
	}

	function toggleGroup(g: PermGroup): void {
		if (disabled) return;
		const all = g.perms.every((p) => selected.includes(p));
		selected = all
			? selected.filter((p) => !g.perms.includes(p))
			: [...new Set([...selected, ...g.perms])];
	}
</script>

<div class="space-y-2.5">
	{#each groups as g (g.prefix)}
		<div>
			<button
				type="button"
				class="mb-1 text-[10px] font-semibold tracking-widest uppercase transition-colors {disabled
					? 'cursor-not-allowed text-faint'
					: 'cursor-pointer text-muted hover:text-fg'}"
				title={g.perms.every((p) => selected.includes(p)) ? 'Clear group' : 'Select group'}
				{disabled}
				onclick={() => {
					toggleGroup(g);
				}}
			>
				{g.prefix}
			</button>
			<div class="flex flex-wrap gap-1.5">
				{#each g.perms as p (p)}
					{@const on = selected.includes(p)}
					<button
						type="button"
						class="chip font-mono transition-colors {on ? 'chip-on' : ''} {disabled
							? 'cursor-not-allowed opacity-50'
							: 'hover:border-accent/60 hover:text-fg'}"
						title={p}
						aria-pressed={on}
						{disabled}
						onclick={() => {
							toggle(p);
						}}
					>
						{suffix(p)}
					</button>
				{/each}
			</div>
		</div>
	{/each}
</div>
