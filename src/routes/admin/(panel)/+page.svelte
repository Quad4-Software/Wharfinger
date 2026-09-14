<script lang="ts">
	import { onMount } from 'svelte';
	import { useInterval } from 'runed';
	import {
		Activity,
		TriangleAlert,
		Bell,
		CircleCheck,
		ExternalLink,
		Eye,
		RefreshCw,
		RotateCcw,
		Settings2,
		Wrench
	} from '@lucide/svelte';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import ActivityFeed from '$lib/components/admin/ActivityFeed.svelte';
	import DashWidget from '$lib/components/admin/DashWidget.svelte';
	import StatusPill from '$lib/components/StatusPill.svelte';
	import { api } from '$lib/state/admin.svelte';
	import { adminHref } from '$lib/state/admin.svelte';
	import { fmtDateTime, fmtMs, relativeTime } from '$lib/utils/format';
	import type { ServiceStatus } from '$lib/shared/status';
	import type { PublicUser } from '$lib/shared/auth';

	interface OverviewService {
		id: string;
		name: string;
		group: string;
		status: ServiceStatus;
		latencyMs: number | null;
		lastDetail: string | null;
		inMaintenance: boolean;
		certDays: number | null;
		certWarn: boolean;
	}
	interface Overview {
		user: PublicUser;
		overall: ServiceStatus;
		services: OverviewService[];
		incidents: { active: { id: string; title: string; severity: string }[]; recent: unknown[] };
		maintenance: {
			active: { id: string; title: string; endsAt: string }[];
			upcoming: { id: string; title: string; startsAt: string }[];
		};
		users: number | null;
		overrides: { section: string; updatedAt: number; updatedBy: string | null }[];
		notifications: {
			enabled: boolean;
			targets: number;
			recent: { target: string; ok: boolean; event: string; at: number; error: string | null }[];
		};
		audit: {
			action: string;
			username: string | null;
			detail: string | null;
			ip: string | null;
			at: number;
		}[];
		admin: { basePath: string };
	}

	type WidgetId =
		| 'services'
		| 'attention'
		| 'maintenance'
		| 'notifications'
		| 'overrides'
		| 'activity'
		| 'markers';
	interface WPref {
		id: WidgetId;
		span: number;
		hidden: boolean;
	}
	const WIDGET_TITLES: Record<WidgetId, string> = {
		services: 'Services',
		attention: 'Needs attention',
		maintenance: 'Maintenance',
		notifications: 'Notifications',
		overrides: 'Runtime overrides',
		activity: 'Recent activity',
		markers: 'Deployment markers'
	};
	const DEFAULT_WIDGETS: WPref[] = [
		{ id: 'services', span: 4, hidden: false },
		{ id: 'attention', span: 2, hidden: false },
		{ id: 'maintenance', span: 2, hidden: false },
		{ id: 'notifications', span: 2, hidden: false },
		{ id: 'overrides', span: 3, hidden: false },
		{ id: 'activity', span: 3, hidden: false },
		{ id: 'markers', span: 3, hidden: true }
	];

	let data = $state<Overview | null>(null);
	let loading = $state(true);
	let loadError = $state(false);
	let customizing = $state(false);
	let widgets = $state<WPref[]>(DEFAULT_WIDGETS.map((w) => ({ ...w })));

	const storageKey = $derived(data ? `dash.v1.${data.user.id}` : null);

	function loadPrefs(): void {
		if (!storageKey) return;
		try {
			const raw = localStorage.getItem(storageKey);
			if (!raw) return;
			const saved = JSON.parse(raw) as WPref[];
			if (!Array.isArray(saved)) return;
			// Merge over defaults so new widgets appear and stale ids drop.
			const merged: WPref[] = [];
			for (const s of saved) {
				const def = DEFAULT_WIDGETS.find((d) => d.id === s.id);
				if (def) {
					merged.push({
						id: def.id,
						span: Math.min(6, Math.max(1, Math.round(s.span) || def.span)),
						hidden: s.hidden
					});
				}
			}
			for (const def of DEFAULT_WIDGETS) {
				if (!merged.some((m) => m.id === def.id)) merged.push({ ...def });
			}
			widgets = merged;
		} catch {
			// corrupt prefs: keep defaults
		}
	}

	function savePrefs(): void {
		if (!storageKey) return;
		try {
			localStorage.setItem(storageKey, JSON.stringify(widgets));
		} catch {
			// storage full or blocked: session-only layout
		}
	}

	function moveWidget(id: WidgetId, dir: -1 | 1): void {
		const i = widgets.findIndex((w) => w.id === id);
		const j = i + dir;
		if (i < 0 || j < 0 || j >= widgets.length) return;
		const next = [...widgets];
		[next[i], next[j]] = [next[j], next[i]];
		widgets = next;
		savePrefs();
	}

	function resizeWidget(id: WidgetId, delta: -1 | 1): void {
		widgets = widgets.map((w) =>
			w.id === id ? { ...w, span: Math.min(6, Math.max(1, w.span + delta)) } : w
		);
		savePrefs();
	}

	function setHidden(id: WidgetId, hidden: boolean): void {
		widgets = widgets.map((w) => (w.id === id ? { ...w, hidden } : w));
		savePrefs();
	}

	function resetWidgets(): void {
		widgets = DEFAULT_WIDGETS.map((w) => ({ ...w }));
		savePrefs();
	}

	interface MarkerRow {
		id: number;
		ts: number;
		title: string;
		kind: string;
		source: string | null;
		service: string | null;
	}
	let markers = $state<MarkerRow[]>([]);
	let markerTitle = $state('');
	let markerKind = $state('deploy');
	let markerService = $state('');
	let markerBusy = $state(false);

	async function loadMarkers(): Promise<void> {
		try {
			const r = await api<{ entries: MarkerRow[] }>('/markers?limit=12');
			markers = r.entries;
		} catch {
			// markers are optional; leave the widget empty
		}
	}

	async function addMarker(): Promise<void> {
		const title = markerTitle.trim();
		if (!title || markerBusy) return;
		markerBusy = true;
		try {
			await api('/markers', {
				body: {
					title,
					kind: markerKind,
					source: 'panel',
					service: markerService || undefined
				}
			});
			markerTitle = '';
			await loadMarkers();
		} finally {
			markerBusy = false;
		}
	}

	async function removeMarker(id: number): Promise<void> {
		await api(`/markers?id=${id}`, { method: 'DELETE' });
		await loadMarkers();
	}

	async function refresh(): Promise<void> {
		try {
			data = await api<Overview>('/overview');
			loadError = false;
		} catch {
			loadError = true;
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void refresh();
		void loadMarkers();
	});
	useInterval(() => 15_000, { callback: () => void refresh() });

	$effect(() => {
		if (data) loadPrefs();
	});

	const down = $derived(
		data?.services.filter((s) => s.status === 'major_outage' || s.status === 'partial_outage') ?? []
	);
	const degraded = $derived(data?.services.filter((s) => s.status === 'degraded') ?? []);
	const inMaint = $derived(data?.services.filter((s) => s.inMaintenance) ?? []);
	const hiddenWidgets = $derived(widgets.filter((w) => w.hidden));
	const visibleWidgets = $derived(
		widgets.filter(
			(w) =>
				!w.hidden &&
				(w.id !== 'overrides' || (data?.overrides.length ?? 0) > 0) &&
				(w.id !== 'activity' || (data?.audit.length ?? 0) > 0)
		)
	);
</script>

<PageHeader title="Dashboard" description="Live view of every monitored service">
	<button
		class="btn {customizing ? 'btn-primary' : ''}"
		onclick={() => (customizing = !customizing)}
	>
		<Settings2 class="size-3.5" />
		{customizing ? 'Done' : 'Customize'}
	</button>
	<button class="btn" onclick={refresh}><RefreshCw class="size-3.5" /> Refresh</button>
</PageHeader>

{#if loading}
	<div class="grid gap-4 lg:grid-cols-6" aria-busy="true">
		<div class="card h-56 animate-pulse lg:col-span-4"></div>
		<div class="card h-56 animate-pulse lg:col-span-2"></div>
		<div class="card h-40 animate-pulse lg:col-span-2"></div>
		<div class="card h-40 animate-pulse lg:col-span-2"></div>
		<div class="card h-40 animate-pulse lg:col-span-3"></div>
		<div class="card h-40 animate-pulse lg:col-span-3"></div>
	</div>
{:else if loadError}
	<div class="card p-6 text-center">
		<p class="text-sm text-muted">Could not load the overview.</p>
		<button class="btn mt-3" onclick={refresh}>Try again</button>
	</div>
{:else if data}
	{#if customizing}
		<div
			class="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-raised px-3 py-2"
		>
			<span class="text-xs font-medium text-muted">Hidden widgets:</span>
			{#each hiddenWidgets as w (w.id)}
				<button
					class="chip flex items-center gap-1 hover:border-accent"
					onclick={() => {
						setHidden(w.id, false);
					}}
				>
					<Eye class="size-3" />
					{WIDGET_TITLES[w.id]}
				</button>
			{:else}
				<span class="text-xs text-faint">none</span>
			{/each}
			<button class="btn btn-ghost btn-sm ml-auto" onclick={resetWidgets}>
				<RotateCcw class="size-3" /> Reset layout
			</button>
		</div>
	{/if}

	<div class="grid gap-4 lg:grid-cols-6">
		{#each visibleWidgets as w, i (w.id)}
			{#if w.id === 'services'}
				<DashWidget
					title={WIDGET_TITLES.services}
					span={w.span}
					{customizing}
					first={i === 0}
					last={i === visibleWidgets.length - 1}
					onmove={(d: -1 | 1) => {
						moveWidget('services', d);
					}}
					onspan={(d: -1 | 1) => {
						resizeWidget('services', d);
					}}
					onhide={() => {
						setHidden('services', true);
					}}
				>
					<div class="mb-4 flex items-center justify-between">
						<h2 class="text-sm font-semibold">Services</h2>
						<StatusPill status={data.overall} />
					</div>
					<div class="divide-y divide-edge">
						{#each data.services as s (s.id)}
							<div class="flex items-center justify-between gap-3 py-2.5">
								<div class="min-w-0">
									<p class="truncate text-sm font-medium">{s.name}</p>
									<p class="truncate text-xs text-faint">
										{s.group}{s.lastDetail ? ` · ${s.lastDetail}` : ''}
									</p>
								</div>
								<div class="flex shrink-0 items-center gap-3">
									{#if s.certWarn}
										<span class="text-xs text-degraded-fg" title="TLS certificate expiring soon">
											cert {s.certDays}d
										</span>
									{/if}
									<span class="w-16 text-right font-mono text-xs text-muted"
										>{fmtMs(s.latencyMs)}</span
									>
									<StatusPill status={s.status} />
								</div>
							</div>
						{/each}
					</div>
				</DashWidget>
			{:else if w.id === 'attention'}
				<DashWidget
					title={WIDGET_TITLES.attention}
					span={w.span}
					{customizing}
					first={i === 0}
					last={i === visibleWidgets.length - 1}
					onmove={(d: -1 | 1) => {
						moveWidget('attention', d);
					}}
					onspan={(d: -1 | 1) => {
						resizeWidget('attention', d);
					}}
					onhide={() => {
						setHidden('attention', true);
					}}
				>
					<h2 class="mb-3 flex items-center gap-2 text-sm font-semibold">
						<TriangleAlert class="size-4 text-degraded-fg" /> Needs attention
					</h2>
					{#if down.length === 0 && degraded.length === 0 && data.incidents.active.length === 0}
						<p class="flex items-center gap-2 text-sm text-up-fg">
							<CircleCheck class="size-4" /> All clear
						</p>
					{:else}
						<ul class="space-y-2 text-sm">
							{#each down as s (s.id)}
								<li class="text-down-fg">{s.name} is down</li>
							{/each}
							{#each degraded as s (s.id)}
								<li class="text-degraded-fg">{s.name} is degraded</li>
							{/each}
							{#each data.incidents.active as inc (inc.id)}
								<li class="text-fg">
									<a class="hover:underline" href={adminHref('/incidents')}>{inc.title}</a>
									<span class="text-xs text-faint">({inc.severity})</span>
								</li>
							{/each}
						</ul>
					{/if}
				</DashWidget>
			{:else if w.id === 'maintenance'}
				<DashWidget
					title={WIDGET_TITLES.maintenance}
					span={w.span}
					{customizing}
					first={i === 0}
					last={i === visibleWidgets.length - 1}
					onmove={(d: -1 | 1) => {
						moveWidget('maintenance', d);
					}}
					onspan={(d: -1 | 1) => {
						resizeWidget('maintenance', d);
					}}
					onhide={() => {
						setHidden('maintenance', true);
					}}
				>
					<h2 class="mb-3 flex items-center gap-2 text-sm font-semibold">
						<Wrench class="size-4 text-maint-fg" /> Maintenance
					</h2>
					{#if data.maintenance.active.length === 0 && data.maintenance.upcoming.length === 0}
						<p class="text-sm text-faint">Nothing scheduled</p>
					{:else}
						<ul class="space-y-2 text-sm">
							{#each data.maintenance.active as win (win.id)}
								<li>
									<span class="text-maint-fg">{win.title}</span>
									<span class="text-xs text-faint">ends {relativeTime(win.endsAt)}</span>
								</li>
							{/each}
							{#each data.maintenance.upcoming.slice(0, 4) as win (win.id)}
								<li>
									{win.title}
									<span class="text-xs text-faint">{fmtDateTime(win.startsAt)}</span>
								</li>
							{/each}
						</ul>
						<a
							class="mt-3 inline-flex items-center gap-1 text-xs text-accent hover:underline"
							href={adminHref('/maintenance')}
						>
							Manage <ExternalLink class="size-3" />
						</a>
					{/if}
					{#if inMaint.length > 0}
						<p class="mt-2 text-xs text-faint">{inMaint.length} service(s) in maintenance now</p>
					{/if}
				</DashWidget>
			{:else if w.id === 'notifications'}
				<DashWidget
					title={WIDGET_TITLES.notifications}
					span={w.span}
					{customizing}
					first={i === 0}
					last={i === visibleWidgets.length - 1}
					onmove={(d: -1 | 1) => {
						moveWidget('notifications', d);
					}}
					onspan={(d: -1 | 1) => {
						resizeWidget('notifications', d);
					}}
					onhide={() => {
						setHidden('notifications', true);
					}}
				>
					<h2 class="mb-3 flex items-center gap-2 text-sm font-semibold">
						<Bell class="size-4" /> Notifications
					</h2>
					{#if data.notifications.targets === 0}
						<p class="text-sm text-faint">No targets configured</p>
						<a
							class="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline"
							href={adminHref('/notifications')}
						>
							Add a target <ExternalLink class="size-3" />
						</a>
					{:else}
						<ul class="space-y-1.5 text-xs">
							{#each data.notifications.recent.slice(0, 5) as n (`${n.at}-${n.target}`)}
								<li class="flex items-center justify-between gap-2">
									<span class="truncate text-muted">
										{n.target} · {n.event}
									</span>
									<span class={n.ok ? 'text-up-fg' : 'text-down-fg'} title={n.error ?? ''}>
										{n.ok ? 'sent' : 'failed'}
										{relativeTime(n.at)}
									</span>
								</li>
							{:else}
								<li class="text-faint">Nothing sent yet</li>
							{/each}
						</ul>
					{/if}
				</DashWidget>
			{:else if w.id === 'overrides'}
				<DashWidget
					title={WIDGET_TITLES.overrides}
					span={w.span}
					{customizing}
					first={i === 0}
					last={i === visibleWidgets.length - 1}
					onmove={(d: -1 | 1) => {
						moveWidget('overrides', d);
					}}
					onspan={(d: -1 | 1) => {
						resizeWidget('overrides', d);
					}}
					onhide={() => {
						setHidden('overrides', true);
					}}
				>
					<h2 class="mb-3 flex items-center gap-2 text-sm font-semibold">
						<Activity class="size-4" /> Runtime overrides
					</h2>
					<ul class="space-y-1.5 text-sm">
						{#each data.overrides as o (o.section)}
							<li class="flex items-center justify-between">
								<span class="font-mono text-xs">{o.section}</span>
								<span class="text-xs text-faint">
									by {o.updatedBy ?? 'unknown'}
									{relativeTime(o.updatedAt)}
								</span>
							</li>
						{/each}
					</ul>
				</DashWidget>
			{:else if w.id === 'activity'}
				<DashWidget
					title={WIDGET_TITLES.activity}
					span={w.span}
					{customizing}
					first={i === 0}
					last={i === visibleWidgets.length - 1}
					onmove={(d: -1 | 1) => {
						moveWidget('activity', d);
					}}
					onspan={(d: -1 | 1) => {
						resizeWidget('activity', d);
					}}
					onhide={() => {
						setHidden('activity', true);
					}}
				>
					<div class="mb-3 flex items-center justify-between">
						<h2 class="text-sm font-semibold">Recent activity</h2>
						<a class="text-xs text-accent hover:underline" href={adminHref('/audit')}>Audit log</a>
					</div>
					<ActivityFeed items={data.audit} limit={8} />
				</DashWidget>
			{:else if w.id === 'markers'}
				<DashWidget
					title={WIDGET_TITLES.markers}
					span={w.span}
					{customizing}
					first={i === 0}
					last={i === visibleWidgets.length - 1}
					onmove={(d: -1 | 1) => {
						moveWidget('markers', d);
					}}
					onspan={(d: -1 | 1) => {
						resizeWidget('markers', d);
					}}
					onhide={() => {
						setHidden('markers', true);
					}}
				>
					<h2 class="mb-3 text-sm font-semibold">Deployment markers</h2>
					<form
						class="mb-3 flex flex-wrap items-end gap-2"
						onsubmit={(e) => {
							e.preventDefault();
							void addMarker();
						}}
					>
						<input
							class="input min-w-40 flex-1 text-xs"
							placeholder="Deploy v1.2.3"
							bind:value={markerTitle}
						/>
						<select class="input w-24 text-xs" bind:value={markerKind}>
							<option value="deploy">deploy</option>
							<option value="release">release</option>
							<option value="config">config</option>
							<option value="note">note</option>
						</select>
						<select class="input w-28 text-xs" bind:value={markerService}>
							<option value="">all services</option>
							{#each data.services as s (s.id)}
								<option value={s.id}>{s.name}</option>
							{/each}
						</select>
						<button class="btn btn-sm" type="submit" disabled={markerBusy || !markerTitle.trim()}>
							Add
						</button>
					</form>
					{#if markers.length === 0}
						<p class="text-xs text-faint">
							No markers yet. CI can POST to /api/markers with an API key to mark deploys on service
							charts.
						</p>
					{:else}
						<ul class="space-y-1.5 text-sm">
							{#each markers as m (m.id)}
								<li class="flex items-center justify-between gap-2">
									<span class="min-w-0 truncate text-xs">
										<span class="chip mr-1.5">{m.kind}</span>{m.title}
										{#if m.service}<span class="text-faint">· {m.service}</span>{/if}
									</span>
									<span class="flex shrink-0 items-center gap-2 text-xs text-faint">
										{relativeTime(m.ts)}
										<button
											class="text-down hover:underline"
											onclick={() => {
												void removeMarker(m.id);
											}}>del</button
										>
									</span>
								</li>
							{/each}
						</ul>
					{/if}
				</DashWidget>
			{/if}
		{/each}
	</div>
{/if}
