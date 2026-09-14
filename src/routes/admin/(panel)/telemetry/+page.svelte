<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Bug,
		Check,
		Copy,
		ChevronLeft,
		CircleCheck,
		CircleX,
		Plus,
		Power,
		Search,
		Trash
	} from '@lucide/svelte';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import Modal from '$lib/components/admin/Modal.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import ConfirmDialog from '$lib/components/admin/ConfirmDialog.svelte';
	import TraceWaterfall from '$lib/components/admin/TraceWaterfall.svelte';
	import { api, ApiError, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import { fmtDateTime, fmtMs, relativeTime } from '$lib/utils/format';

	interface Project {
		id: number;
		name: string;
		key: string;
		dsn: string;
		platform: string | null;
		createdAt: number;
		disabledAt: number | null;
	}
	interface Issue {
		projectId: number;
		fingerprint: string;
		title: string;
		culprit: string | null;
		level: string;
		firstSeen: number;
		lastSeen: number;
		count: number;
		resolvedAt: number | null;
	}
	interface EventRow {
		id: number;
		eventId: string | null;
		ts: number;
		level: string;
		platform: string | null;
		message: string | null;
		excType: string | null;
		excValue: string | null;
		release: string | null;
		environment: string | null;
		tags: string;
		request: string | null;
		stack: string | null;
		raw: string;
	}

	interface TraceRow {
		id: number;
		projectId: number;
		traceId: string;
		spanId: string | null;
		name: string;
		op: string | null;
		ts: number;
		durationMs: number;
		spanCount: number;
		status: string | null;
		release: string | null;
		environment: string | null;
	}
	interface TxStat {
		name: string;
		count: number;
		avg: number;
		p50: number;
		p95: number;
		p99: number;
		lastSeen: number;
	}

	let tab = $state<'issues' | 'traces' | 'projects'>('issues');
	let loading = $state(true);
	let projects = $state<Project[]>([]);
	let issues = $state<Issue[]>([]);
	let total = $state(0);
	let page = $state(1);
	const pageSize = 50;
	let q = $state('');
	let unresolvedOnly = $state(true);
	let filterProject = $state(0);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	// issue detail
	let detail = $state<Issue | null>(null);
	let detailEvents = $state<EventRow[]>([]);
	let detailTotal = $state(0);
	let detailPage = $state(1);
	let detailLoading = $state(false);
	let expandedEvent = $state<number | null>(null);

	// project create
	let createOpen = $state(false);
	let newName = $state('');
	let newPlatform = $state('');
	let created = $state<Project | null>(null);
	let busy = $state(false);
	let deleteTarget = $state<Project | null>(null);
	let deleteOpen = $state(false);
	let copied = $state(false);

	// traces tab
	let tProject = $state(0);
	let tStats = $state<TxStat[]>([]);
	let tTraces = $state<TraceRow[]>([]);
	let tTotal = $state(0);
	let tPage = $state(1);
	let tName = $state('');
	let tLoading = $state(false);
	let tLoaded = $state(false);
	let tDetail = $state<{ trace: TraceRow; spans: TraceWaterfallSpan[] } | null>(null);
	let tDetailLoading = $state(false);
	interface TraceWaterfallSpan {
		spanId: string;
		parentSpanId: string | null;
		op: string | null;
		description: string | null;
		startMs: number;
		endMs: number;
		status: string | null;
	}

	const pages = $derived(Math.max(1, Math.ceil(total / pageSize)));
	const detailPages = $derived(Math.max(1, Math.ceil(detailTotal / 20)));
	const tPages = $derived(Math.max(1, Math.ceil(tTotal / 50)));
	const projectName = $derived(
		(id: number) => projects.find((p) => p.id === id)?.name ?? `project ${id}`
	);

	async function load(): Promise<void> {
		try {
			const [pr, ir] = await Promise.all([
				api<{ projects: Project[] }>('/telemetry/projects'),
				api<{ issues: Issue[]; total: number }>(
					`/telemetry/issues?page=${page}${filterProject ? `&project=${filterProject}` : ''}${unresolvedOnly ? '&unresolved=1' : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`
				)
			]);
			projects = pr.projects;
			issues = ir.issues;
			total = ir.total;
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'load failed');
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function onSearch(): void {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			page = 1;
			void load();
		}, 300);
	}

	async function openDetail(i: Issue): Promise<void> {
		detail = i;
		detailPage = 1;
		expandedEvent = null;
		await loadDetail();
	}

	async function loadDetail(): Promise<void> {
		if (!detail) return;
		detailLoading = true;
		try {
			const r = await api<{ issue: Issue; events: EventRow[]; total: number }>(
				`/telemetry/issues/${detail.projectId}/${detail.fingerprint}?page=${detailPage}`
			);
			detail = r.issue;
			detailEvents = r.events;
			detailTotal = r.total;
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'load failed');
		} finally {
			detailLoading = false;
		}
	}

	async function loadTraces(): Promise<void> {
		if (!tProject && projects.length > 0) tProject = projects[0].id;
		if (!tProject) return;
		tLoading = true;
		try {
			const [sr, tr] = await Promise.all([
				api<{ stats: TxStat[] }>(`/telemetry/traces/stats?project=${tProject}`),
				api<{ traces: TraceRow[]; total: number }>(
					`/telemetry/traces?project=${tProject}&page=${tPage}${tName ? `&name=${encodeURIComponent(tName)}` : ''}`
				)
			]);
			tStats = sr.stats;
			tTraces = tr.traces;
			tTotal = tr.total;
			tLoaded = true;
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'load failed');
		} finally {
			tLoading = false;
		}
	}

	async function openTrace(t: TraceRow): Promise<void> {
		tDetailLoading = true;
		try {
			tDetail = await api<{ trace: TraceRow; spans: TraceWaterfallSpan[] }>(
				`/telemetry/traces/${t.projectId}/${t.traceId}`
			);
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'load failed');
		} finally {
			tDetailLoading = false;
		}
	}

	function filterByName(name: string): void {
		tName = tName === name ? '' : name;
		tPage = 1;
		void loadTraces();
	}

	async function setResolved(resolved: boolean): Promise<void> {
		if (!detail) return;
		try {
			await api(`/telemetry/issues/${detail.projectId}/${detail.fingerprint}`, {
				method: 'PATCH',
				body: { resolved }
			});
			toast('success', resolved ? 'Issue resolved' : 'Issue reopened');
			await loadDetail();
			await load();
		} catch (err) {
			toast('error', errMessage(err));
		}
	}

	async function createProject(): Promise<void> {
		if (!newName.trim()) return;
		busy = true;
		try {
			const r = await api<{ project: Project }>('/telemetry/projects', {
				body: { name: newName.trim(), platform: newPlatform.trim() || undefined }
			});
			created = r.project;
			newName = '';
			newPlatform = '';
			await load();
		} catch (err) {
			toast('error', errMessage(err));
		} finally {
			busy = false;
		}
	}

	async function toggleProject(p: Project): Promise<void> {
		try {
			await api(`/telemetry/projects/${p.id}`, {
				method: 'PATCH',
				body: { disabled: !p.disabledAt }
			});
			toast('success', p.disabledAt ? 'Project enabled' : 'Project disabled');
			await load();
		} catch (err) {
			toast('error', errMessage(err));
		}
	}

	async function deleteProject(): Promise<void> {
		if (!deleteTarget) return;
		try {
			await api(`/telemetry/projects/${deleteTarget.id}`, { method: 'DELETE' });
			toast('success', 'Project deleted');
			deleteTarget = null;
			deleteOpen = false;
			await load();
		} catch (err) {
			toast('error', errMessage(err));
		}
	}

	function copy(text: string): void {
		void navigator.clipboard.writeText(text).then(() => {
			copied = true;
			setTimeout(() => (copied = false), 1500);
		});
	}

	function levelClass(l: string): string {
		if (l === 'fatal' || l === 'error') return 'text-down';
		if (l === 'warning') return 'text-degraded';
		return 'text-faint';
	}

	function stackFrames(
		raw: string | null
	): { filename?: string; function?: string; lineno?: number }[] {
		if (!raw) return [];
		try {
			return JSON.parse(raw) as { filename?: string; function?: string; lineno?: number }[];
		} catch {
			return [];
		}
	}

	function parseJson(raw: string | null): Record<string, unknown> | null {
		if (!raw) return null;
		try {
			return JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return null;
		}
	}
</script>

<PageHeader
	title="Error tracking"
	description="Sentry-protocol ingest: point any SDK DSN at this hub and issues group here."
>
	<button class="btn btn-primary" onclick={() => (createOpen = true)}>
		<Plus class="size-4" /> New project
	</button>
</PageHeader>

<div class="mb-4 flex gap-1">
	{#each [['issues', 'Issues'], ['traces', 'Traces'], ['projects', `Projects (${projects.length})`]] as const as [v, label] (v)}
		<button
			class="btn {tab === v ? 'btn-primary' : 'btn-ghost'} !px-3 !py-1 text-xs"
			onclick={() => {
				tab = v;
				if (v === 'traces' && !tLoaded) void loadTraces();
			}}>{label}</button
		>
	{/each}
</div>

{#if tab === 'issues'}
	{#if detail}
		<div class="card p-5">
			<button
				class="mb-3 flex items-center gap-1 text-xs text-accent hover:underline"
				onclick={() => (detail = null)}
			>
				<ChevronLeft class="size-3.5" /> All issues
			</button>
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div class="min-w-0">
					<h2 class="text-sm font-semibold {levelClass(detail.level)}">{detail.title}</h2>
					<p class="mt-0.5 text-xs text-faint">
						{projectName(detail.projectId)}{detail.culprit ? ` · ${detail.culprit}` : ''} ·
						{detail.count} events · first {relativeTime(detail.firstSeen)} · last
						{relativeTime(detail.lastSeen)}
					</p>
				</div>
				<div class="flex shrink-0 gap-2">
					{#if detail.resolvedAt}
						<span class="chip chip-on">resolved</span>
						<button class="btn btn-sm" onclick={() => void setResolved(false)}>Reopen</button>
					{:else}
						<button class="btn btn-sm" onclick={() => void setResolved(true)}>
							<CircleCheck class="size-3.5" /> Resolve
						</button>
					{/if}
				</div>
			</div>

			{#if detailLoading}
				<p class="mt-4 text-sm text-faint">Loading events...</p>
			{:else}
				<div class="mt-4 space-y-2">
					{#each detailEvents as e (e.id)}
						<div class="rounded-lg border border-edge">
							<button
								class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
								onclick={() => (expandedEvent = expandedEvent === e.id ? null : e.id)}
							>
								<div class="min-w-0">
									<p class="truncate text-xs font-medium text-fg">
										{e.excType ?? 'message'}{e.excValue ? `: ${e.excValue}` : ''}
									</p>
									<p class="truncate text-[11px] text-faint">
										{fmtDateTime(new Date(e.ts).toISOString())}
										{e.release ? ` · ${e.release}` : ''}{e.environment ? ` · ${e.environment}` : ''}
									</p>
								</div>
								<span class="text-xs {levelClass(e.level)}">{e.level}</span>
							</button>
							{#if expandedEvent === e.id}
								<div class="space-y-3 border-t border-edge px-3 py-3">
									{#if e.message}
										<p class="text-xs text-muted">{e.message}</p>
									{/if}
									{#if stackFrames(e.stack).length > 0}
										<div>
											<p class="mb-1 text-[11px] font-medium text-faint">Stack trace</p>
											<div class="max-h-64 overflow-y-auto rounded bg-bg p-2 font-mono text-[11px]">
												{#each [...stackFrames(e.stack)].reverse() as f, i (i)}
													<div class="truncate {f.function ? 'text-muted' : 'text-faint'}">
														at {f.function ?? '<anon>'} ({f.filename}:{f.lineno ?? '?'})
													</div>
												{/each}
											</div>
										</div>
									{/if}
									{#if parseJson(e.request)}
										{@const req = parseJson(e.request)}
										{#if req}
											<p class="text-[11px] text-faint">
												{req.method ?? ''}
												{req.url ?? ''}
											</p>
										{/if}
									{/if}
									{#if parseJson(e.tags) && Object.keys(parseJson(e.tags) ?? {}).length > 0}
										<div class="flex flex-wrap gap-1">
											{#each Object.entries(parseJson(e.tags) ?? {}) as [k, v] (k)}
												<span class="chip">{k}={String(v).slice(0, 40)}</span>
											{/each}
										</div>
									{/if}
								</div>
							{/if}
						</div>
					{:else}
						<p class="py-4 text-center text-xs text-faint">No events stored.</p>
					{/each}
					{#if detailPages > 1}
						<div class="flex items-center justify-center gap-2 pt-2 text-xs">
							<button
								class="btn btn-ghost btn-sm"
								disabled={detailPage <= 1}
								onclick={() => {
									detailPage--;
									void loadDetail();
								}}>Prev</button
							>
							<span class="text-faint">{detailPage} / {detailPages}</span>
							<button
								class="btn btn-ghost btn-sm"
								disabled={detailPage >= detailPages}
								onclick={() => {
									detailPage++;
									void loadDetail();
								}}>Next</button
							>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{:else}
		<div class="mb-3 flex flex-wrap items-center gap-2">
			<div class="relative min-w-48 flex-1">
				<Search
					class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint"
				/>
				<input
					class="input w-full pl-8 text-xs"
					bind:value={q}
					oninput={onSearch}
					placeholder="Search issues..."
				/>
			</div>
			<select
				class="input w-auto text-xs"
				bind:value={filterProject}
				onchange={() => {
					page = 1;
					void load();
				}}
			>
				<option value={0}>All projects</option>
				{#each projects as p (p.id)}
					<option value={p.id}>{p.name}</option>
				{/each}
			</select>
			<label class="flex items-center gap-1.5 text-xs text-muted">
				<input
					type="checkbox"
					class="accent-accent"
					bind:checked={unresolvedOnly}
					onchange={() => {
						page = 1;
						void load();
					}}
				/>
				Unresolved only
			</label>
		</div>

		{#if loading}
			<div class="card h-40 animate-pulse"></div>
		{:else if issues.length === 0}
			<div class="card flex flex-col items-center gap-3 px-6 py-12 text-center">
				<Bug class="size-8 text-faint" />
				<p class="text-sm text-muted">
					{unresolvedOnly
						? 'No unresolved issues. Errors your apps send will group here.'
						: 'No issues found.'}
				</p>
				<button class="btn btn-primary" onclick={() => (createOpen = true)}>
					<Plus class="size-4" /> Create a project DSN
				</button>
			</div>
		{:else}
			<div class="card divide-y divide-edge">
				{#each issues as i (i.fingerprint)}
					<button
						class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-raised/50"
						onclick={() => void openDetail(i)}
					>
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span class="truncate text-sm font-medium {levelClass(i.level)}">{i.title}</span>
								{#if i.resolvedAt}<span class="chip chip-on">resolved</span>{/if}
							</div>
							<p class="mt-0.5 truncate text-xs text-faint">
								{projectName(i.projectId)}{i.culprit ? ` · ${i.culprit}` : ''}
							</p>
						</div>
						<div class="shrink-0 text-right text-xs text-faint">
							<p>{i.count} events</p>
							<p>{relativeTime(i.lastSeen)}</p>
						</div>
					</button>
				{/each}
			</div>
			{#if pages > 1}
				<div class="mt-3 flex items-center justify-center gap-2 text-xs">
					<button
						class="btn btn-ghost btn-sm"
						disabled={page <= 1}
						onclick={() => {
							page--;
							void load();
						}}>Prev</button
					>
					<span class="text-faint">{page} / {pages}</span>
					<button
						class="btn btn-ghost btn-sm"
						disabled={page >= pages}
						onclick={() => {
							page++;
							void load();
						}}>Next</button
					>
				</div>
			{/if}
		{/if}
	{/if}
{:else if tab === 'traces'}
	{#if tDetailLoading}
		<div class="card h-40 animate-pulse"></div>
	{:else if tDetail}
		<div class="card p-5">
			<button
				class="mb-3 flex items-center gap-1 text-xs text-accent hover:underline"
				onclick={() => (tDetail = null)}
			>
				<ChevronLeft class="size-3.5" /> All traces
			</button>
			<h2 class="truncate text-sm font-semibold text-fg">{tDetail.trace.name}</h2>
			<p class="mt-0.5 text-xs text-faint">
				{fmtDateTime(new Date(tDetail.trace.ts).toISOString())} ·
				{fmtMs(tDetail.trace.durationMs)} · {tDetail.trace.spanCount} spans{tDetail.trace.status
					? ` · ${tDetail.trace.status}`
					: ''}{tDetail.trace.release ? ` · ${tDetail.trace.release}` : ''}
			</p>
			<p class="mt-0.5 font-mono text-[11px] text-faint">trace {tDetail.trace.traceId}</p>
			<div class="mt-4">
				<TraceWaterfall
					name={tDetail.trace.name}
					op={tDetail.trace.op}
					spanId={tDetail.trace.spanId}
					startMs={tDetail.trace.ts}
					durationMs={tDetail.trace.durationMs}
					status={tDetail.trace.status}
					spans={tDetail.spans}
				/>
			</div>
		</div>
	{:else}
		<div class="mb-3 flex flex-wrap items-center gap-2">
			<select
				class="input w-auto text-xs"
				bind:value={tProject}
				onchange={() => {
					tPage = 1;
					tName = '';
					void loadTraces();
				}}
			>
				{#each projects as p (p.id)}
					<option value={p.id}>{p.name}</option>
				{/each}
			</select>
			{#if tName}
				<button
					class="chip chip-on"
					onclick={() => {
						filterByName(tName);
					}}>{tName} &times;</button
				>
			{/if}
		</div>

		{#if !tLoaded && tLoading}
			<div class="card h-40 animate-pulse"></div>
		{:else if projects.length === 0}
			<div class="card px-6 py-12 text-center">
				<p class="text-sm text-muted">Create a project first, then send it transactions.</p>
			</div>
		{:else}
			{#if tStats.length > 0}
				<div class="card mb-4 overflow-x-auto">
					<table class="w-full text-xs">
						<thead>
							<tr class="border-b border-edge text-left text-faint">
								<th class="px-4 py-2 font-medium">Transaction</th>
								<th class="px-3 py-2 text-right font-medium">Count</th>
								<th class="px-3 py-2 text-right font-medium">Avg</th>
								<th class="px-3 py-2 text-right font-medium">p50</th>
								<th class="px-3 py-2 text-right font-medium">p95</th>
								<th class="px-3 py-2 text-right font-medium">p99</th>
								<th class="px-4 py-2 text-right font-medium">Last seen</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-edge">
							{#each tStats as s (s.name)}
								<tr
									class="cursor-pointer transition-colors hover:bg-raised/50 {tName === s.name
										? 'bg-raised/40'
										: ''}"
									onclick={() => {
										filterByName(s.name);
									}}
								>
									<td class="max-w-64 truncate px-4 py-2 font-medium text-fg">{s.name}</td>
									<td class="px-3 py-2 text-right text-muted">{s.count}</td>
									<td class="px-3 py-2 text-right text-muted">{fmtMs(s.avg)}</td>
									<td class="px-3 py-2 text-right text-muted">{fmtMs(s.p50)}</td>
									<td class="px-3 py-2 text-right text-muted">{fmtMs(s.p95)}</td>
									<td class="px-3 py-2 text-right text-muted">{fmtMs(s.p99)}</td>
									<td class="px-4 py-2 text-right text-faint">{relativeTime(s.lastSeen)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}

			<div class="card divide-y divide-edge">
				{#each tTraces as t (t.id)}
					<button
						class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-raised/50"
						onclick={() => void openTrace(t)}
					>
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span class="truncate text-sm font-medium text-fg">{t.name}</span>
								{#if t.op}<span class="chip">{t.op}</span>{/if}
								{#if t.status && t.status !== 'ok'}
									<span class="chip text-down">{t.status}</span>
								{/if}
							</div>
							<p class="mt-0.5 truncate font-mono text-[11px] text-faint">{t.traceId}</p>
						</div>
						<div class="shrink-0 text-right text-xs text-faint">
							<p>{fmtMs(t.durationMs)} · {t.spanCount} spans</p>
							<p>{relativeTime(t.ts)}</p>
						</div>
					</button>
				{:else}
					<p class="px-6 py-10 text-center text-sm text-muted">
						{tName
							? 'No traces match this transaction.'
							: 'No transactions recorded yet. SDK performance envelopes land here.'}
					</p>
				{/each}
			</div>
			{#if tPages > 1}
				<div class="mt-3 flex items-center justify-center gap-2 text-xs">
					<button
						class="btn btn-ghost btn-sm"
						disabled={tPage <= 1}
						onclick={() => {
							tPage--;
							void loadTraces();
						}}>Prev</button
					>
					<span class="text-faint">{tPage} / {tPages}</span>
					<button
						class="btn btn-ghost btn-sm"
						disabled={tPage >= tPages}
						onclick={() => {
							tPage++;
							void loadTraces();
						}}>Next</button
					>
				</div>
			{/if}
		{/if}
	{/if}
{:else}
	<div class="card divide-y divide-edge">
		{#each projects as p (p.id)}
			<div class="flex items-center gap-3 px-4 py-3">
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-2">
						<span class="truncate text-sm font-medium">{p.name}</span>
						{#if p.platform}<span class="chip">{p.platform}</span>{/if}
						{#if p.disabledAt}<span class="chip text-down">disabled</span>{/if}
					</div>
					<p class="mt-0.5 truncate font-mono text-xs text-faint">{p.dsn}</p>
				</div>
				<div class="flex shrink-0 items-center gap-1">
					<button
						class="btn btn-ghost btn-sm"
						title="Copy DSN"
						onclick={() => {
							copy(p.dsn);
						}}
					>
						{#if copied}<Check class="size-3.5 text-up-fg" />{:else}<Copy class="size-3.5" />{/if}
					</button>
					<button
						class="btn btn-ghost btn-sm"
						title={p.disabledAt ? 'Enable' : 'Disable'}
						onclick={() => void toggleProject(p)}
					>
						<Power class="size-3.5 {p.disabledAt ? 'text-faint' : 'text-up-fg'}" />
					</button>
					<button
						class="btn btn-ghost btn-sm text-down-fg"
						title="Delete"
						onclick={() => {
							deleteTarget = p;
							deleteOpen = true;
						}}
					>
						<Trash class="size-3.5" />
					</button>
				</div>
			</div>
		{:else}
			<div class="px-6 py-10 text-center">
				<CircleX class="mx-auto mb-3 size-8 text-faint" />
				<p class="text-sm text-muted">No projects yet. Create one to get a DSN for your apps.</p>
			</div>
		{/each}
	</div>
	<div class="mt-4 card p-4 text-xs text-faint">
		<p class="mb-1 font-medium text-muted">Using the DSN</p>
		<p>
			Any Sentry SDK works: set the DSN in your app and events arrive here, grouped into issues.
			Supported endpoints: <code class="font-mono">/api/&lt;id&gt;/envelope/</code> and
			<code class="font-mono">/api/&lt;id&gt;/store/</code>. Request cookies, authorization headers,
			and secrets are filtered before storage.
		</p>
	</div>
{/if}

<Modal bind:open={createOpen} title="New telemetry project">
	{#if created}
		<div class="space-y-4">
			<p class="text-sm text-muted">
				Project "{created.name}" is live. Set this DSN in your app's Sentry SDK:
			</p>
			<div class="flex gap-2">
				<code
					class="min-w-0 flex-1 overflow-x-auto rounded-md border border-edge bg-bg px-2 py-1.5 font-mono text-xs"
					>{created.dsn}</code
				>
				<button
					class="btn btn-ghost shrink-0"
					onclick={() => {
						copy(created?.dsn ?? '');
					}}
				>
					{#if copied}<Check class="size-4 text-up-fg" />{:else}<Copy class="size-4" />{/if}
				</button>
			</div>
			<button
				class="btn btn-primary w-full"
				onclick={() => {
					createOpen = false;
					created = null;
				}}>Done</button
			>
		</div>
	{:else}
		<form
			class="space-y-4"
			onsubmit={(e) => {
				e.preventDefault();
				void createProject();
			}}
		>
			<Field label="Project name" required hint="e.g. api-server or web-frontend.">
				<input class="input w-full" bind:value={newName} maxlength="80" required />
			</Field>
			<Field label="Platform" hint="Optional, e.g. node, python, javascript.">
				<input class="input w-full" bind:value={newPlatform} maxlength="40" />
			</Field>
			<button class="btn btn-primary w-full" type="submit" disabled={busy || !newName.trim()}>
				Create project
			</button>
		</form>
	{/if}
</Modal>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Delete project?"
	description={`"${deleteTarget?.name ?? ''}" and all its events will be permanently removed.`}
	confirmLabel="Delete"
	danger
	onconfirm={() => void deleteProject()}
/>
