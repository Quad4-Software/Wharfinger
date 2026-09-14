<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import {
		Activity,
		ArrowDown,
		ArrowUp,
		Badge,
		Check,
		Copy,
		Link2,
		Pencil,
		Play,
		Plus,
		Trash
	} from '@lucide/svelte';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import SectionChip from '$lib/components/admin/SectionChip.svelte';
	import SaveBar from '$lib/components/admin/SaveBar.svelte';
	import ConfirmDialog from '$lib/components/admin/ConfirmDialog.svelte';
	import ServiceEditor from '$lib/components/admin/ServiceEditor.svelte';
	import Modal from '$lib/components/admin/Modal.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import type { ServiceDraft } from '$lib/shared/drafts';
	import StatusPill from '$lib/components/StatusPill.svelte';
	import { api, ApiError, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import type { ServiceStatus } from '$lib/shared/status';

	type RawService = Record<string, unknown> & { id: string; name: string; type: string };

	interface OverviewService {
		id: string;
		status: ServiceStatus;
		inMaintenance: boolean;
	}
	interface SectionView {
		value: RawService[];
		overridden: boolean;
		updatedAt: number | null;
	}
	interface SloRow {
		service: string;
		target_percent: number;
		window_days: number;
	}
	interface SloSection {
		value: SloRow[];
		overridden: boolean;
		updatedAt: number | null;
	}

	let loaded = $state<RawService[]>([]);
	let draft = $state<RawService[]>([]);
	let overridden = $state(false);
	let updatedAt = $state<number | null>(null);
	let statuses = $state<Map<string, OverviewService>>(new Map());
	let loading = $state(true);
	let pushUrls = $state<Record<string, string>>({});
	let pushCopied = $state('');

	let slosLoaded = $state<SloRow[]>([]);
	let slosDraft = $state<SloRow[]>([]);
	let slosOverridden = $state(false);
	let slosUpdatedAt = $state<number | null>(null);
	let slosSaving = $state(false);
	const slosDirty = $derived(JSON.stringify(slosDraft) !== JSON.stringify(slosLoaded));

	let editorOpen = $state(false);
	let editing = $state<ServiceDraft | null>(null);
	let editingIdx = $state(-1);
	let deleteIdx = $state(-1);
	let deleteOpen = $state(false);
	let saving = $state(false);
	let checking = $state<string | null>(null);

	const dirty = $derived(JSON.stringify(draft) !== JSON.stringify(loaded));

	async function load(): Promise<void> {
		try {
			const [sec, ov, pu, sloSec] = await Promise.all([
				api<SectionView>('/sections/services'),
				api<{ services: OverviewService[] }>('/overview'),
				api<{ urls: Record<string, string> }>('/push-urls').catch(() => ({ urls: {} })),
				api<SloSection>('/sections/slos').catch(() => ({
					value: [],
					overridden: false,
					updatedAt: null
				}))
			]);
			loaded = Array.isArray(sec.value) ? sec.value : [];
			draft = structuredClone(loaded);
			overridden = sec.overridden;
			updatedAt = sec.updatedAt;
			statuses = new Map(ov.services.map((s) => [s.id, s]));
			pushUrls = pu.urls;
			slosLoaded = Array.isArray(sloSec.value) ? sloSec.value : [];
			slosDraft = structuredClone(slosLoaded);
			slosOverridden = sloSec.overridden;
			slosUpdatedAt = sloSec.updatedAt;
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'load failed');
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function field(s: RawService, key: string): string {
		const v = s[key];
		return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
	}
	function targetOf(s: RawService): string {
		if (s.type === 'http') return field(s, 'url');
		if (s.type === 'json') return `${field(s, 'url')} [${field(s, 'json_path')}]`;
		if (s.type === 'websocket') return field(s, 'url');
		if (s.type === 'rdap') return field(s, 'domain');
		if (s.type === 'domain') return field(s, 'domain');
		if (s.type === 'push') {
			return `every ${field(s, 'expected_interval_seconds') || '300'}s + ${field(s, 'grace_seconds') || '60'}s grace`;
		}
		if (s.type === 'dns') return `${field(s, 'host')} (${field(s, 'record_type') || 'A'})`;
		const port = field(s, 'port');
		return `${field(s, 'host')}${port ? `:${port}` : ''}`;
	}

	function openNew(): void {
		editing = null;
		editingIdx = -1;
		editorOpen = true;
	}
	function openEdit(i: number): void {
		editing = draft[i] as ServiceDraft;
		editingIdx = i;
		editorOpen = true;
	}
	function onEditorSave(d: ServiceDraft): void {
		if (editingIdx === -1) draft = [...draft, d];
		else draft = draft.map((s, i) => (i === editingIdx ? d : s));
		toast(
			'info',
			editingIdx === -1 ? 'Service added; save to apply' : 'Service updated; save to apply'
		);
	}
	function move(i: number, dir: -1 | 1): void {
		const j = i + dir;
		if (j < 0 || j >= draft.length) return;
		const next = [...draft];
		[next[i], next[j]] = [next[j], next[i]];
		draft = next;
	}

	async function saveSlos(): Promise<void> {
		slosSaving = true;
		try {
			await api('/sections/slos', {
				method: 'PUT',
				body: { value: slosDraft, expected: slosUpdatedAt }
			});
			toast('success', 'SLOs saved and applied');
			await load();
		} catch (err) {
			toast('error', errMessage(err, 'save failed').slice(0, 300));
		} finally {
			slosSaving = false;
		}
	}

	function sloOf(id: string): SloRow | undefined {
		return slosDraft.find((s) => s.service === id);
	}
	function setSlo(id: string, patch: Partial<SloRow>): void {
		const cur = sloOf(id);
		if (cur) {
			slosDraft = slosDraft.map((s) => (s.service === id ? { ...s, ...patch } : s));
		} else {
			slosDraft = [...slosDraft, { service: id, target_percent: 99.9, window_days: 30, ...patch }];
		}
	}

	function copyPushUrl(id: string): void {
		const url = pushUrls[id];
		if (!url) return;
		void navigator.clipboard.writeText(url).then(() => {
			pushCopied = id;
			setTimeout(() => (pushCopied = ''), 1500);
		});
	}

	async function save(): Promise<void> {
		saving = true;
		try {
			await api('/sections/services', {
				method: 'PUT',
				body: { value: draft, expected: updatedAt }
			});
			toast('success', 'Services saved and applied');
			await load();
		} catch (err) {
			toast('error', errMessage(err, 'save failed').slice(0, 300));
		} finally {
			saving = false;
		}
	}

	// Badge builder state.
	let badgeSvc = $state<RawService | null>(null);
	let badgeOpen = $state(false);
	let badgeMetric = $state<'status' | 'uptime' | 'latency'>('status');
	let badgeRange = $state<'24h' | '7d' | '30d' | '90d'>('24h');
	let badgeStyle = $state<'flat' | 'flat-square' | 'for-the-badge' | 'plastic'>('flat');
	let badgeLabel = $state('');
	let badgeColor = $state('');
	let badgeLabelColor = $state('');
	let badgeCopied = $state('');

	const badgeUrl = $derived.by(() => {
		if (!badgeSvc) return '';
		const p = new SvelteURLSearchParams();
		if (badgeMetric !== 'status') p.set('metric', badgeMetric);
		if (badgeMetric === 'uptime' && badgeRange !== '24h') p.set('range', badgeRange);
		if (badgeStyle !== 'flat') p.set('style', badgeStyle);
		if (badgeLabel.trim()) p.set('label', badgeLabel.trim());
		if (/^#[0-9a-f]{6}$/i.test(badgeColor)) p.set('color', badgeColor);
		if (/^#[0-9a-f]{6}$/i.test(badgeLabelColor)) p.set('labelColor', badgeLabelColor);
		const q = p.toString();
		return `/badge/${badgeSvc.id}.svg${q ? `?${q}` : ''}`;
	});

	function openBadge(s: RawService): void {
		badgeSvc = s;
		badgeMetric = 'status';
		badgeRange = '24h';
		badgeStyle = 'flat';
		badgeLabel = '';
		badgeColor = '';
		badgeLabelColor = '';
		badgeOpen = true;
	}

	function copyBadge(kind: string, text: string): void {
		void navigator.clipboard.writeText(text).then(() => {
			badgeCopied = kind;
			setTimeout(() => (badgeCopied = ''), 1500);
		});
	}

	async function runCheck(s: RawService): Promise<void> {
		checking = s.id;
		try {
			const r = await api<{ ok: boolean; detail: string | null; latencyMs: number }>(
				'/services/check',
				{ body: { service: s } }
			);
			toast(
				r.ok ? 'success' : 'error',
				`${s.name}: ${r.detail ?? (r.ok ? 'up' : 'down')} (${Math.round(r.latencyMs)}ms)`
			);
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'check failed');
		} finally {
			checking = null;
		}
	}
</script>

<PageHeader title="Services" description="Monitored endpoints; changes apply live on save">
	<SectionChip section="services" {overridden} onreset={load} />
	<button class="btn btn-primary" onclick={openNew}><Plus class="size-4" /> Add service</button>
</PageHeader>

{#if loading}
	<div class="card h-64 animate-pulse"></div>
{:else if draft.length === 0}
	<div class="card p-10 text-center">
		<Activity class="mx-auto mb-3 size-8 text-faint" />
		<p class="text-muted">No services configured.</p>
		<button class="btn btn-primary mt-4" onclick={openNew}
			><Plus class="size-4" /> Add the first service</button
		>
	</div>
{:else}
	<div class="card divide-y divide-edge">
		{#each draft as s, i (s.id || i)}
			{@const st = statuses.get(s.id)}
			<div class="flex items-center gap-3 px-4 py-3">
				<div class="flex w-10 shrink-0 flex-col">
					<button
						class="text-faint hover:text-fg disabled:opacity-30"
						onclick={() => {
							move(i, -1);
						}}
						disabled={i === 0}
						aria-label="Move up"
					>
						<ArrowUp class="size-3.5" />
					</button>
					<button
						class="text-faint hover:text-fg disabled:opacity-30"
						onclick={() => {
							move(i, 1);
						}}
						disabled={i === draft.length - 1}
						aria-label="Move down"
					>
						<ArrowDown class="size-3.5" />
					</button>
				</div>
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-2">
						<span class="truncate text-sm font-medium">{s.name}</span>
						<span class="chip">{s.type}</span>
						{#if s.group}<span class="text-xs text-faint">{s.group}</span>{/if}
					</div>
					<p class="mt-0.5 truncate font-mono text-xs text-faint">{s.id} · {targetOf(s)}</p>
				</div>
				{#if st}<StatusPill status={st.status} />{/if}
				<div class="flex shrink-0 items-center gap-1">
					{#if s.type === 'push' && pushUrls[s.id]}
						<button
							class="btn btn-ghost btn-sm"
							title="Copy check-in URL"
							onclick={() => {
								copyPushUrl(s.id);
							}}
						>
							{#if pushCopied === s.id}<Check class="size-3.5 text-up-fg" />{:else}<Link2
									class="size-3.5"
								/>{/if}
						</button>
					{/if}
					<button
						class="btn btn-ghost btn-sm"
						title="Badge"
						onclick={() => {
							openBadge(s);
						}}
					>
						<Badge class="size-3.5" />
					</button>
					<button
						class="btn btn-ghost btn-sm"
						title="Run check now"
						disabled={checking === s.id}
						onclick={() => runCheck(s)}
					>
						<Play class="size-3.5" />
					</button>
					<button
						class="btn btn-ghost btn-sm"
						title="Edit"
						onclick={() => {
							openEdit(i);
						}}
					>
						<Pencil class="size-3.5" />
					</button>
					<button
						class="btn btn-ghost btn-sm text-down-fg"
						title="Delete"
						onclick={() => {
							deleteIdx = i;
							deleteOpen = true;
						}}
					>
						<Trash class="size-3.5" />
					</button>
				</div>
			</div>
		{/each}
	</div>

	<section class="mt-8">
		<div class="mb-3 flex items-center justify-between">
			<div>
				<h2 class="text-sm font-semibold">SLO targets</h2>
				<p class="text-xs text-faint">
					Uptime objective per service; drives the error-budget and burn-rate readout on service
					cards.
				</p>
			</div>
			<SectionChip section="slos" overridden={slosOverridden} onreset={load} />
		</div>
		<div class="card divide-y divide-edge">
			{#each draft as s (s.id)}
				{@const slo = sloOf(s.id)}
				<div class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
					<span class="min-w-0 flex-1 truncate font-medium">{s.name}</span>
					<label class="flex items-center gap-1.5 text-xs text-muted">
						target %
						<input
							class="input w-20 px-2 py-1 text-xs"
							type="number"
							min="50"
							max="100"
							step="0.01"
							value={slo?.target_percent ?? ''}
							placeholder="off"
							oninput={(e) => {
								const v = e.currentTarget.value;
								if (v === '') {
									slosDraft = slosDraft.filter((x) => x.service !== s.id);
								} else {
									setSlo(s.id, { target_percent: Number(v) });
								}
							}}
						/>
					</label>
					<label class="flex items-center gap-1.5 text-xs text-muted">
						window days
						<input
							class="input w-16 px-2 py-1 text-xs"
							type="number"
							min="1"
							max="90"
							value={slo?.window_days ?? 30}
							disabled={!slo}
							oninput={(e) => {
								setSlo(s.id, { window_days: Number(e.currentTarget.value) });
							}}
						/>
					</label>
					{#if slo}<span class="chip chip-on">on</span>{:else}<span class="chip">off</span>{/if}
				</div>
			{/each}
		</div>
		<SaveBar
			dirty={slosDirty}
			saving={slosSaving}
			onsave={saveSlos}
			ondiscard={() => (slosDraft = structuredClone(slosLoaded))}
		/>
	</section>
{/if}

<SaveBar {dirty} {saving} onsave={save} ondiscard={() => (draft = structuredClone(loaded))} />

<ServiceEditor
	bind:open={editorOpen}
	service={editing}
	existingIds={draft.map((s) => s.id)}
	onsave={onEditorSave}
/>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Delete service?"
	description={`${draft[deleteIdx]?.name ?? 'This service'} will stop being monitored. Its history stays in the database but disappears from the page.`}
	confirmLabel="Delete"
	danger
	onconfirm={() => {
		draft = draft.filter((_, i) => i !== deleteIdx);
		deleteIdx = -1;
	}}
/>

<Modal bind:open={badgeOpen} title={`Badge: ${badgeSvc?.name ?? ''}`}>
	{#if badgeSvc}
		<div class="space-y-4">
			<div class="grid grid-cols-2 gap-3">
				<Field label="Metric">
					<select class="input w-full" bind:value={badgeMetric}>
						<option value="status">Status</option>
						<option value="uptime">Uptime</option>
						<option value="latency">Latency</option>
					</select>
				</Field>
				{#if badgeMetric === 'uptime'}
					<Field label="Window">
						<select class="input w-full" bind:value={badgeRange}>
							<option value="24h">24h</option>
							<option value="7d">7d</option>
							<option value="30d">30d</option>
							<option value="90d">90d</option>
						</select>
					</Field>
				{/if}
				<Field label="Style">
					<select class="input w-full" bind:value={badgeStyle}>
						<option value="flat">Flat</option>
						<option value="flat-square">Flat square</option>
						<option value="for-the-badge">For the badge</option>
						<option value="plastic">Plastic</option>
					</select>
				</Field>
				<Field label="Label override" hint="Defaults to the service name.">
					<input class="input w-full" bind:value={badgeLabel} maxlength="60" />
				</Field>
				<Field label="Value color" hint="#rrggbb, optional.">
					<input class="input w-full font-mono" bind:value={badgeColor} placeholder="#10b981" />
				</Field>
				<Field label="Label color" hint="#rrggbb, optional.">
					<input
						class="input w-full font-mono"
						bind:value={badgeLabelColor}
						placeholder="#1f2937"
					/>
				</Field>
			</div>

			<div class="rounded-lg border border-edge bg-bg px-4 py-6 text-center">
				<img src={badgeUrl} alt="badge preview" class="inline-block" />
			</div>

			<div class="space-y-2">
				{#each [['url', badgeUrl], ['markdown', `[![status](${location.origin}${badgeUrl})](${location.origin})`], ['html', `<img src="${location.origin}${badgeUrl}" alt="status" />`]] as const as [kind, text] (kind)}
					<div class="flex items-center gap-2">
						<code
							class="min-w-0 flex-1 truncate rounded-md border border-edge bg-bg px-2 py-1.5 font-mono text-xs"
							>{text}</code
						>
						<button
							class="btn btn-ghost shrink-0 !p-1.5"
							title="Copy"
							onclick={() => {
								copyBadge(kind, text);
							}}
						>
							{#if badgeCopied === kind}<Check class="size-4 text-up-fg" />{:else}<Copy
									class="size-4"
								/>{/if}
						</button>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</Modal>
