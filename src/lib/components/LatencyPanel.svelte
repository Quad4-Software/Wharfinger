<script lang="ts">
	import { ToggleGroup } from 'bits-ui';
	import { untrack } from 'svelte';
	import { LoaderCircle, RotateCcw } from '@lucide/svelte';
	import type { LatencyPoint, ServiceSnapshot } from '$lib/shared/types';
	import type { LatencyRange } from '$lib/shared/uptime';
	import { paths } from '$lib/shared/paths';
	import LatencyChart from './LatencyChart.svelte';

	const { service }: { service: ServiceSnapshot } = $props();

	const RANGES: { value: LatencyRange; label: string }[] = [
		{ value: '24h', label: '24h' },
		{ value: '7d', label: '7d' },
		{ value: '30d', label: '30d' }
	];

	interface MarkerPoint {
		ts: number;
		title: string;
		kind: string;
	}

	let range = $state<LatencyRange>('24h');
	let points = $state<LatencyPoint[]>(untrack(() => service.latency));
	let markers = $state<MarkerPoint[]>(untrack(() => service.markers ?? []));
	let loading = $state(false);
	let fetchError = $state(false);
	let ac: AbortController | null = null;

	function load(r: LatencyRange): void {
		ac?.abort();
		const ctrl = new AbortController();
		ac = ctrl;
		loading = true;
		fetchError = false;
		fetch(paths.apiHistory(service.id, r), { signal: ctrl.signal })
			.then(async (res) => {
				if (!res.ok) throw new Error(String(res.status));
				const body = (await res.json()) as {
					series: LatencyPoint[];
					markers?: MarkerPoint[];
				};
				points = body.series;
				markers = body.markers ?? [];
			})
			.catch(() => {
				if (!ctrl.signal.aborted) fetchError = true;
			})
			.finally(() => {
				if (!ctrl.signal.aborted) loading = false;
			});
	}

	function retry(): void {
		load(range);
	}

	// The 24h view ships inside the snapshot; longer ranges stream in on
	// demand so the main payload stays small.
	$effect(() => {
		const r = range;
		if (r === '24h') {
			ac?.abort();
			points = service.latency;
			markers = service.markers ?? [];
			fetchError = false;
			return;
		}
		load(r);
		return () => {
			ac?.abort();
		};
	});
</script>

<div class="space-y-2">
	<div class="flex items-center justify-between">
		<span class="text-xs text-muted">Response time</span>
		<ToggleGroup.Root
			type="single"
			bind:value={range}
			class="inline-flex overflow-hidden rounded-lg ring-1 ring-edge"
		>
			{#each RANGES as r (r.value)}
				<ToggleGroup.Item
					value={r.value}
					disabled={loading}
					class="px-2.5 py-1 text-xs text-muted transition-colors hover:text-fg disabled:opacity-50 data-[state=on]:bg-overlay/10 data-[state=on]:text-fg"
				>
					{r.label}
				</ToggleGroup.Item>
			{/each}
		</ToggleGroup.Root>
	</div>
	<div class="relative" aria-busy={loading}>
		{#if fetchError}
			<div
				class="flex h-[100px] flex-col items-center justify-center gap-2 text-xs text-faint"
				role="alert"
			>
				<span>Could not load history</span>
				<button class="btn btn-sm" onclick={retry}>
					<RotateCcw class="size-3.5" /> Retry
				</button>
			</div>
		{:else}
			<div class:opacity-40={loading} class="transition-opacity">
				<LatencyChart {points} {markers} />
			</div>
		{/if}
		{#if loading}
			<div class="pointer-events-none absolute inset-0 flex items-center justify-center">
				<LoaderCircle class="size-5 animate-spin text-muted" />
			</div>
		{/if}
	</div>
</div>
