<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { useInterval } from 'runed';
	import {
		Activity,
		CalendarClock,
		ChevronRight,
		CircleCheck,
		Siren,
		TriangleAlert,
		X
	} from '@lucide/svelte';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import StatTile from '$lib/components/admin/StatTile.svelte';
	import { api, ApiError, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import { fmtDateTime, relativeTime } from '$lib/utils/format';

	type Severity = 'info' | 'warn' | 'alert';

	interface Anomaly {
		id: number;
		metric: string;
		value: number;
		expected: number;
		z: number;
		severity: Severity;
		detail: string | null;
		createdAt: number;
		ackedAt: number | null;
		ackedBy: string | null;
	}
	interface Summary {
		openAlerts: number;
		warns24h: number;
		metricsTracked: number;
		lastAnomalyAt: number | null;
	}
	interface MetricStat {
		metric: string;
		n: number;
		mean: number;
		sd: number;
		updatedAt: number;
	}

	let entries = $state<Anomaly[]>([]);
	let summary = $state<Summary | null>(null);
	let metricStats = $state<MetricStat[]>([]);
	let nextCursor = $state<number | null>(null);
	let status = $state<'open' | 'acked' | 'all'>('open');
	let severity = $state<'' | Severity>('');
	let metric = $state('');
	let loading = $state(true);
	let loadingMore = $state(false);
	let expanded = $state<number | null>(null);
	let ackBusy = $state<number | null>(null);

	const filtersActive = $derived(severity !== '' || metric !== '' || status !== 'open');

	async function load(): Promise<void> {
		try {
			const params = new SvelteURLSearchParams({ limit: '50' });
			if (status !== 'all') params.set('status', status);
			if (severity) params.set('severity', severity);
			if (metric) params.set('metric', metric);
			const [a, m] = await Promise.all([
				api<{ entries: Anomaly[]; nextCursor: number | null; summary: Summary }>(
					`/anomalies?${params}`
				),
				api<{ metrics: MetricStat[] }>('/anomalies/metrics')
			]);
			entries = a.entries;
			nextCursor = a.nextCursor;
			summary = a.summary;
			metricStats = m.metrics;
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'load failed');
		} finally {
			loading = false;
		}
	}

	async function loadMore(): Promise<void> {
		if (nextCursor === null || loadingMore) return;
		loadingMore = true;
		try {
			const params = new SvelteURLSearchParams({ limit: '50', cursor: String(nextCursor) });
			if (status !== 'all') params.set('status', status);
			if (severity) params.set('severity', severity);
			if (metric) params.set('metric', metric);
			const a = await api<{ entries: Anomaly[]; nextCursor: number | null }>(
				`/anomalies?${params}`
			);
			entries = [...entries, ...a.entries];
			nextCursor = a.nextCursor;
		} catch (err) {
			toast('error', errMessage(err));
		} finally {
			loadingMore = false;
		}
	}

	onMount(() => void load());
	useInterval(() => 30_000, { callback: () => void load() });

	function setStatus(v: 'open' | 'acked' | 'all'): void {
		status = v;
		void load();
	}

	function setSeverity(v: '' | Severity): void {
		severity = v;
		void load();
	}

	function setMetric(v: string): void {
		metric = v;
		void load();
	}

	function clearFilters(): void {
		status = 'open';
		severity = '';
		metric = '';
		void load();
	}

	async function ack(a: Anomaly): Promise<void> {
		if (ackBusy !== null) return;
		ackBusy = a.id;
		try {
			await api(`/anomalies/${a.id}/ack`, { method: 'POST', body: {} });
			toast('success', `Acknowledged ${a.metric}`);
			await load();
		} catch (err) {
			toast('error', errMessage(err));
		} finally {
			ackBusy = null;
		}
	}

	function sevChip(s: Severity): string {
		if (s === 'alert') return 'border-down/50 text-down-fg';
		if (s === 'warn') return 'border-degraded/50 text-degraded-fg';
		return '';
	}

	function fmtVal(v: number): string {
		return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
	}

	// Ratio against the pre-update baseline; meaningless when the
	// baseline sits at zero, so fall back to the z score there.
	function vsBaseline(a: Anomaly): string {
		if (Math.abs(a.expected) > 1e-6) {
			return `${(a.value / a.expected).toFixed(1)}x baseline`;
		}
		return `z=${a.z.toFixed(1)}`;
	}

	function detailLines(raw: string | null): string[] {
		if (!raw) return [];
		try {
			const obj = JSON.parse(raw) as Record<string, unknown>;
			return Object.entries(obj).map(([k, v]) => `${k}: ${String(v)}`);
		} catch {
			return [raw];
		}
	}
</script>

<PageHeader
	title="Anomalies"
	description="Rolling-baseline detection over auth, deploy, service, config, and agent metrics"
></PageHeader>

{#if summary === null}
	<div class="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
		{#each [0, 1, 2, 3] as i (i)}
			<div class="card h-[4.75rem] animate-pulse"></div>
		{/each}
	</div>
{:else}
	<div class="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
		<StatTile
			label="Open alerts"
			value={String(summary.openAlerts)}
			sub="unacknowledged"
			tone={summary.openAlerts > 0 ? 'bad' : 'default'}
		>
			{#snippet icon()}<Siren class="size-4" />{/snippet}
		</StatTile>
		<StatTile
			label="Warns (24h)"
			value={String(summary.warns24h)}
			sub="last 24 hours"
			tone={summary.warns24h > 0 ? 'warn' : 'default'}
		>
			{#snippet icon()}<TriangleAlert class="size-4" />{/snippet}
		</StatTile>
		<StatTile label="Metrics tracked" value={String(summary.metricsTracked)} sub="active baselines">
			{#snippet icon()}<Activity class="size-4" />{/snippet}
		</StatTile>
		<StatTile
			label="Last anomaly"
			value={summary.lastAnomalyAt ? relativeTime(summary.lastAnomalyAt) : 'never'}
			sub={summary.lastAnomalyAt
				? fmtDateTime(new Date(summary.lastAnomalyAt).toISOString())
				: 'nothing recorded'}
		>
			{#snippet icon()}<CalendarClock class="size-4" />{/snippet}
		</StatTile>
	</div>
{/if}

<div class="mb-4 flex flex-wrap items-center gap-2">
	<div class="flex gap-1">
		{#each [['open', 'Open'], ['acked', 'Acked'], ['all', 'All']] as const as [v, label] (v)}
			<button
				class="btn {status === v ? 'btn-primary' : 'btn-ghost'} !px-3 !py-1 text-xs"
				onclick={() => {
					setStatus(v);
				}}>{label}</button
			>
		{/each}
	</div>
	<div class="flex gap-1">
		{#each [['', 'any severity'], ['warn', 'warn'], ['alert', 'alert']] as const as [v, label] (v)}
			<button
				class="btn {severity === v ? 'btn-primary' : 'btn-ghost'} !px-3 !py-1 text-xs"
				onclick={() => {
					setSeverity(v);
				}}>{label}</button
			>
		{/each}
	</div>
	<select
		class="input w-auto text-xs"
		value={metric}
		onchange={(e) => {
			setMetric(e.currentTarget.value);
		}}
		aria-label="Filter by metric"
	>
		<option value="">all metrics</option>
		{#each metricStats as m (m.metric)}
			<option value={m.metric}>{m.metric}</option>
		{/each}
	</select>
</div>

{#if filtersActive}
	<div class="mb-4 flex flex-wrap items-center gap-2">
		<span class="text-xs text-faint">Filtered by</span>
		{#if status !== 'open'}
			<button
				class="chip chip-on"
				title="Remove status filter"
				onclick={() => {
					setStatus('open');
				}}
			>
				status: {status}
				<X class="size-3" />
			</button>
		{/if}
		{#if severity}
			<button
				class="chip chip-on"
				title="Remove severity filter"
				onclick={() => {
					setSeverity('');
				}}
			>
				severity: {severity}
				<X class="size-3" />
			</button>
		{/if}
		{#if metric}
			<button
				class="chip chip-on"
				title="Remove metric filter"
				onclick={() => {
					setMetric('');
				}}
			>
				metric: {metric}
				<X class="size-3" />
			</button>
		{/if}
		<button class="btn btn-ghost btn-sm" onclick={clearFilters}>Clear all</button>
	</div>
{/if}

{#if loading && entries.length === 0}
	<div class="card divide-y divide-edge">
		{#each [0, 1, 2, 3, 4] as r (r)}
			<div class="flex items-center gap-3 px-4 py-3">
				<div class="h-5 w-12 shrink-0 animate-pulse rounded bg-panel"></div>
				<div class="min-w-0 flex-1 space-y-1.5">
					<div class="h-3 w-1/3 animate-pulse rounded bg-panel"></div>
					<div class="h-2.5 w-1/2 animate-pulse rounded bg-panel"></div>
				</div>
				<div class="h-3 w-12 animate-pulse rounded bg-panel"></div>
			</div>
		{/each}
	</div>
{:else if entries.length === 0}
	<div class="card p-10 text-center">
		<TriangleAlert class="mx-auto mb-3 size-8 text-faint" />
		{#if filtersActive}
			<p class="text-muted">Nothing matches these filters.</p>
			<button class="btn mt-4" onclick={clearFilters}>Clear filters</button>
		{:else}
			<p class="text-muted">No anomalies recorded. Baselines build over the first 30 samples.</p>
		{/if}
	</div>
{:else}
	<div class="card divide-y divide-edge" aria-busy={loading}>
		{#each entries as a (a.id)}
			<div class="px-4 py-2.5">
				<div class="flex items-start gap-3">
					<span class="chip mt-0.5 shrink-0 font-mono {sevChip(a.severity)}">{a.severity}</span>
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
							<span class="truncate text-sm font-medium text-fg">{a.metric}</span>
							{#if a.ackedAt}
								<span class="chip chip-on" title={a.ackedBy ? `by ${a.ackedBy}` : ''}>
									acked {relativeTime(a.ackedAt)}
								</span>
							{/if}
						</div>
						<p class="mt-0.5 text-xs text-muted">
							{fmtVal(a.value)} observed, {vsBaseline(a)} (z={a.z.toFixed(1)})
						</p>
					</div>
					<div class="flex shrink-0 items-center gap-2">
						<span
							class="text-xs text-muted"
							title={fmtDateTime(new Date(a.createdAt).toISOString())}
						>
							{relativeTime(a.createdAt)}
						</span>
						{#if a.detail}
							<button
								class="btn btn-ghost btn-sm"
								aria-expanded={expanded === a.id}
								aria-label={expanded === a.id ? 'Hide detail' : 'Show detail'}
								onclick={() => (expanded = expanded === a.id ? null : a.id)}
							>
								<ChevronRight
									class="size-3.5 transition-transform {expanded === a.id ? 'rotate-90' : ''}"
								/>
							</button>
						{/if}
						{#if !a.ackedAt}
							<button class="btn btn-sm" disabled={ackBusy === a.id} onclick={() => void ack(a)}>
								<CircleCheck class="size-3.5" />
								{ackBusy === a.id ? 'Acking...' : 'Ack'}
							</button>
						{/if}
					</div>
				</div>
				{#if expanded === a.id && a.detail}
					<div class="mt-2 space-y-0.5 rounded-lg border border-edge bg-raised px-3 py-2">
						{#each detailLines(a.detail) as line, i (i)}
							<p class="font-mono text-[11px] text-muted">{line}</p>
						{/each}
					</div>
				{/if}
			</div>
		{/each}
	</div>

	{#if nextCursor !== null}
		<div class="mt-4 flex justify-center">
			<button class="btn btn-ghost btn-sm" disabled={loadingMore} onclick={() => void loadMore()}>
				{loadingMore ? 'Loading...' : 'Load older'}
			</button>
		</div>
	{/if}
{/if}
