<script lang="ts" generics="T">
	import { ArrowDown, ArrowUp, ArrowUpDown, Inbox, Search } from '@lucide/svelte';
	import type { Snippet } from 'svelte';

	// Reusable data table: column definitions declare a sort value per
	// row; search filters across all columns. Keeps table markup out of
	// every admin card. row is a snippet so callers keep full control of
	// cell rendering.
	interface Column<T> {
		label: string;
		class?: string;
		// Sort key for the row; omit for an unsortable column.
		sort?: (row: T) => string | number | null;
	}

	const {
		columns,
		rows,
		rowKey,
		searchable = false,
		searchPlaceholder = 'Search...',
		empty = 'Nothing to show',
		maxHeight,
		row
	}: {
		columns: Column<T>[];
		rows: T[];
		rowKey: (row: T) => string | number;
		searchable?: boolean;
		searchPlaceholder?: string;
		empty?: string;
		maxHeight?: string;
		row: Snippet<[T]>;
	} = $props();

	let q = $state('');
	let sortCol = $state<number | null>(null);
	let sortDir = $state<1 | -1>(1);

	const filtered = $derived.by(() => {
		const needle = q.trim().toLowerCase();
		let out = rows;
		if (needle) {
			out = out.filter((r) =>
				columns.some((c) => {
					const v = c.sort?.(r);
					return v !== null && v !== undefined && String(v).toLowerCase().includes(needle);
				})
			);
		}
		if (sortCol !== null) {
			const key = columns[sortCol]?.sort;
			if (key) {
				out = [...out].sort((a, b) => {
					const va = key(a);
					const vb = key(b);
					if (va === null) return 1;
					if (vb === null) return -1;
					const c =
						typeof va === 'number' && typeof vb === 'number'
							? va - vb
							: String(va).localeCompare(String(vb));
					return c * sortDir;
				});
			}
		}
		return out;
	});

	function toggleSort(i: number): void {
		if (sortCol === i) {
			if (sortDir === 1) sortDir = -1;
			else sortCol = null;
		} else {
			sortCol = i;
			sortDir = 1;
		}
	}
</script>

{#if searchable}
	<div class="relative mb-3">
		<Search
			class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint"
		/>
		<input
			class="input pl-8 text-xs"
			bind:value={q}
			placeholder={searchPlaceholder}
			aria-label="Filter table"
		/>
	</div>
{/if}

<div class="overflow-x-auto" style={maxHeight ? `max-height:${maxHeight};overflow-y:auto` : ''}>
	<table class="w-full text-left text-xs">
		<thead>
			<tr class="border-b border-edge text-faint">
				{#each columns as c, i (c.label)}
					<th class="py-1.5 pr-3 font-medium {c.class ?? ''}">
						{#if c.sort}
							<button
								class="inline-flex items-center gap-1 hover:text-fg"
								onclick={() => {
									toggleSort(i);
								}}
							>
								{c.label}
								{#if sortCol === i}
									{#if sortDir === 1}<ArrowUp class="size-3" />{:else}<ArrowDown
											class="size-3"
										/>{/if}
								{:else}
									<ArrowUpDown class="size-3 opacity-40" />
								{/if}
							</button>
						{:else}
							{c.label}
						{/if}
					</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each filtered as r (rowKey(r))}
				<tr class="border-b border-edge/50 last:border-0">
					{@render row(r)}
				</tr>
			{/each}
		</tbody>
	</table>
	{#if filtered.length === 0}
		<p class="flex items-center justify-center gap-2 py-4 text-xs text-faint">
			<Inbox class="size-4" />
			{empty}
		</p>
	{/if}
</div>
