<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteDate, SvelteURLSearchParams } from 'svelte/reactivity';
	import {
		CalendarDays,
		ChevronLeft,
		ChevronRight,
		Download,
		ScrollText,
		Search,
		ShieldAlert,
		ShieldCheck,
		Users,
		X
	} from '@lucide/svelte';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import StatTile from '$lib/components/admin/StatTile.svelte';
	import { api, ApiError, adminHref } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import { fmtDate, fmtDateTime, relativeTime } from '$lib/utils/format';
	import { describeAction, iconForAction, type AuditKind } from '$lib/utils/audit-kind';

	interface AuditEntry {
		id: number;
		username: string | null;
		action: string;
		detail: string | null;
		ip: string | null;
		at: number;
	}
	interface AuditSummary {
		today: number;
		week: number;
		actors: number;
		failedAuth: number;
	}
	interface DayGroup {
		label: string;
		items: AuditEntry[];
	}

	const { data }: { data: { perms: string[] } } = $props();
	const canVerify = $derived(data.perms.includes('admin.settings'));

	let entries = $state<AuditEntry[]>([]);
	let summary = $state<AuditSummary | null>(null);
	let actions = $state<string[]>([]);
	let total = $state(0);
	let pageSize = $state(50);
	let page = $state(1);
	let action = $state('');
	let q = $state('');
	let actor = $state('');
	let loading = $state(true);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let verifying = $state(false);
	let chainResult = $state<{ ok: boolean; rows: number; firstBadId?: number } | null>(null);

	const pages = $derived(Math.max(1, Math.ceil(total / pageSize)));
	const filtersActive = $derived(action !== '' || actor !== '' || q.trim() !== '');
	const exportHref = $derived(
		`${adminHref('/api/audit')}?format=csv${action ? `&action=${encodeURIComponent(action)}` : ''}${actor ? `&user=${encodeURIComponent(actor)}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`
	);

	async function load(): Promise<void> {
		loading = true;
		try {
			const params = new SvelteURLSearchParams({ page: String(page) });
			if (action) params.set('action', action);
			if (actor.trim()) params.set('user', actor.trim());
			if (q.trim()) params.set('q', q.trim());
			const r = await api<{
				entries: AuditEntry[];
				total: number;
				pageSize: number;
				actions: string[];
				summary: AuditSummary;
			}>(`/audit?${params}`);
			entries = r.entries;
			total = r.total;
			pageSize = r.pageSize;
			actions = r.actions;
			summary = r.summary;
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'load failed');
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function filterAction(v: string): void {
		action = v;
		page = 1;
		void load();
	}

	function filterActor(v: string): void {
		actor = v;
		page = 1;
		void load();
	}

	function search(v: string): void {
		q = v;
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			page = 1;
			void load();
		}, 300);
	}

	function searchActor(v: string): void {
		actor = v;
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			page = 1;
			void load();
		}, 300);
	}

	function clearSearch(): void {
		clearTimeout(searchTimer);
		q = '';
		page = 1;
		void load();
	}

	function clearFilters(): void {
		clearTimeout(searchTimer);
		action = '';
		actor = '';
		q = '';
		page = 1;
		void load();
	}

	function sameDay(a: Date, b: Date): boolean {
		return (
			a.getFullYear() === b.getFullYear() &&
			a.getMonth() === b.getMonth() &&
			a.getDate() === b.getDate()
		);
	}

	// Entries arrive ordered newest-first, so same-day rows are always
	// contiguous; a new group starts when the local day changes.
	const groups = $derived.by((): DayGroup[] => {
		const out: DayGroup[] = [];
		const today = new SvelteDate();
		const yesterday = new SvelteDate();
		yesterday.setDate(yesterday.getDate() - 1);
		for (const e of entries) {
			const d = new SvelteDate(e.at);
			const label = sameDay(d, today)
				? 'Today'
				: sameDay(d, yesterday)
					? 'Yesterday'
					: fmtDate(d.toISOString());
			const last = out.at(-1);
			if (last?.label === label) last.items.push(e);
			else out.push({ label, items: [e] });
		}
		return out;
	});

	function iconTone(kind: AuditKind): string {
		if (kind === 'bad') return 'text-down';
		if (kind === 'warn') return 'text-degraded';
		if (kind === 'ok') return 'text-up';
		if (kind === 'accent') return 'text-accent';
		return 'text-faint';
	}

	function pillTone(kind: AuditKind): string {
		if (kind === 'bad') return 'border-down/50 text-down-fg';
		if (kind === 'warn') return 'border-degraded/50 text-degraded-fg';
		if (kind === 'ok') return 'border-up/50 text-up-fg';
		if (kind === 'accent') return 'border-accent/50 text-accent';
		return '';
	}

	async function verifyChain(): Promise<void> {
		verifying = true;
		try {
			chainResult = await api<{ ok: boolean; rows: number; firstBadId?: number }>('/audit/verify');
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'verify failed');
		} finally {
			verifying = false;
		}
	}
</script>

<PageHeader title="Audit log" description="Every administrative action is recorded here">
	<div class="flex flex-wrap items-center gap-2">
		<div class="relative">
			<Search
				class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint"
			/>
			<input
				class="input w-44 pl-8 sm:w-56"
				value={q}
				oninput={(e) => {
					search(e.currentTarget.value);
				}}
				placeholder="Search detail, ip, action..."
				aria-label="Search audit log"
			/>
		</div>
		<select
			class="input w-auto"
			value={action}
			onchange={(e) => {
				filterAction(e.currentTarget.value);
			}}
			aria-label="Filter by action"
		>
			<option value="">all actions</option>
			{#each actions as a (a)}
				<option value={a}>{a}</option>
			{/each}
		</select>
		<input
			class="input w-32"
			value={actor}
			oninput={(e) => {
				searchActor(e.currentTarget.value);
			}}
			placeholder="actor"
			aria-label="Filter by actor"
		/>
		<a class="btn btn-ghost btn-sm" href={exportHref} download>
			<Download class="size-3.5" /> CSV
		</a>
		{#if canVerify}
			<button class="btn btn-ghost btn-sm" disabled={verifying} onclick={() => void verifyChain()}>
				<ShieldCheck class="size-3.5" />
				{verifying ? 'Verifying...' : 'Verify integrity'}
			</button>
			{#if chainResult}
				<span class="text-xs {chainResult.ok ? 'text-up-fg' : 'text-down-fg'}">
					{chainResult.ok
						? `chain intact, ${chainResult.rows} rows`
						: `chain broken at row ${chainResult.firstBadId}`}
				</span>
			{/if}
		{/if}
	</div>
</PageHeader>

{#if summary === null}
	<div class="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
		{#each [0, 1, 2, 3] as i (i)}
			<div class="card h-[4.75rem] animate-pulse"></div>
		{/each}
	</div>
{:else}
	<div class="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
		<StatTile label="Events today" value={String(summary.today)} sub="since midnight">
			{#snippet icon()}<CalendarDays class="size-4" />{/snippet}
		</StatTile>
		<StatTile label="This week" value={String(summary.week)} sub="last 7 days">
			{#snippet icon()}<ScrollText class="size-4" />{/snippet}
		</StatTile>
		<StatTile label="Actors" value={String(summary.actors)} sub="distinct usernames">
			{#snippet icon()}<Users class="size-4" />{/snippet}
		</StatTile>
		<StatTile
			label="Failed auth"
			value={String(summary.failedAuth)}
			sub="denied or failed sign-ins"
			tone={summary.failedAuth > 0 ? 'bad' : 'default'}
		>
			{#snippet icon()}<ShieldAlert class="size-4" />{/snippet}
		</StatTile>
	</div>
{/if}

{#if filtersActive}
	<div class="mb-4 flex flex-wrap items-center gap-2">
		<span class="text-xs text-faint">Filtered by</span>
		{#if action}
			<button
				class="chip chip-on"
				title="Remove action filter"
				onclick={() => {
					filterAction('');
				}}
			>
				action: {action}
				<X class="size-3" />
			</button>
		{/if}
		{#if actor.trim()}
			<button
				class="chip chip-on"
				title="Remove actor filter"
				onclick={() => {
					filterActor('');
				}}
			>
				actor: {actor.trim()}
				<X class="size-3" />
			</button>
		{/if}
		{#if q.trim()}
			<button class="chip chip-on" title="Remove search filter" onclick={clearSearch}>
				search: {q.trim()}
				<X class="size-3" />
			</button>
		{/if}
		<button class="btn btn-ghost btn-sm" onclick={clearFilters}>Clear all</button>
	</div>
{/if}

{#if loading && entries.length === 0}
	<div class="space-y-4">
		{#each [0, 1] as g (g)}
			<div class="card overflow-hidden">
				<div class="border-b border-edge px-4 py-2.5">
					<div class="h-3 w-24 animate-pulse rounded bg-panel"></div>
				</div>
				{#each [0, 1, 2, 3] as r (r)}
					<div class="flex items-center gap-3 px-4 py-3">
						<div class="size-4 shrink-0 animate-pulse rounded-full bg-panel"></div>
						<div class="min-w-0 flex-1 space-y-1.5">
							<div class="h-3 w-1/3 animate-pulse rounded bg-panel"></div>
							<div class="h-2.5 w-1/2 animate-pulse rounded bg-panel"></div>
						</div>
						<div class="h-3 w-12 animate-pulse rounded bg-panel"></div>
					</div>
				{/each}
			</div>
		{/each}
	</div>
{:else if entries.length === 0}
	<div class="card p-10 text-center">
		<ScrollText class="mx-auto mb-3 size-8 text-faint" />
		{#if filtersActive}
			<p class="text-muted">Nothing matches these filters.</p>
			<button class="btn mt-4" onclick={clearFilters}>Clear filters</button>
		{:else}
			<p class="text-muted">Nothing recorded yet.</p>
		{/if}
	</div>
{:else}
	<div
		class="space-y-5 transition-opacity {loading ? 'pointer-events-none opacity-50' : ''}"
		aria-busy={loading}
	>
		{#each groups as g (g.label)}
			<section>
				<div class="mb-2 flex items-center gap-2 px-1">
					<h2 class="text-xs font-semibold tracking-widest text-faint uppercase">{g.label}</h2>
					<span class="chip">{g.items.length}</span>
				</div>
				<div class="card divide-y divide-edge">
					{#each g.items as e (e.id)}
						{@const d = describeAction(e.action)}
						{@const Icon = iconForAction(e.action)}
						<div class="flex items-start gap-3 px-4 py-2.5">
							<span class="mt-0.5 shrink-0 {iconTone(d.kind)}">
								<Icon class="size-4" />
							</span>
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
									<span class="chip font-mono {pillTone(d.kind)}" title={d.label}>
										{e.action}
									</span>
									{#if e.username}
										<button
											class="chip transition-colors hover:border-accent hover:text-fg"
											title="Filter by {e.username}"
											onclick={() => {
												filterActor(e.username ?? '');
											}}
										>
											{e.username}
										</button>
									{:else}
										<span class="chip">system</span>
									{/if}
									<span class="text-xs text-muted">{d.label}</span>
								</div>
								{#if e.detail}
									<p class="mt-1 truncate text-xs text-muted" title={e.detail}>{e.detail}</p>
								{/if}
							</div>
							<div class="shrink-0 text-right">
								<p class="text-xs text-muted" title={fmtDateTime(new Date(e.at).toISOString())}>
									{relativeTime(e.at)}
								</p>
								{#if e.ip}
									<p class="mt-0.5 font-mono text-[11px] text-faint">{e.ip}</p>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			</section>
		{/each}
	</div>

	{#if pages > 1}
		<div class="mt-4 flex items-center justify-center gap-2 text-sm">
			<button
				class="btn btn-ghost btn-sm"
				disabled={page <= 1}
				onclick={() => {
					page -= 1;
					void load();
				}}
			>
				<ChevronLeft class="size-3.5" /> Prev
			</button>
			<span class="px-2 text-faint">page {page} of {pages}</span>
			<button
				class="btn btn-ghost btn-sm"
				disabled={page >= pages}
				onclick={() => {
					page += 1;
					void load();
				}}
			>
				Next <ChevronRight class="size-3.5" />
			</button>
		</div>
	{/if}
{/if}
