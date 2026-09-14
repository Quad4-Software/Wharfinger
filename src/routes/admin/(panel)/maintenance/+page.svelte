<script lang="ts">
	import { onMount } from 'svelte';
	import { CalendarClock, Pencil, Plus, Repeat, Trash } from '@lucide/svelte';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import SectionChip from '$lib/components/admin/SectionChip.svelte';
	import SaveBar from '$lib/components/admin/SaveBar.svelte';
	import ConfirmDialog from '$lib/components/admin/ConfirmDialog.svelte';
	import MaintenanceEditor from '$lib/components/admin/MaintenanceEditor.svelte';
	import type { MaintDraft } from '$lib/shared/drafts';
	import { api, ApiError, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import { fmtDateTime } from '$lib/utils/format';

	interface SectionView {
		value: MaintDraft[];
		overridden: boolean;
		updatedAt: number | null;
	}
	interface ActiveWindow {
		id: string;
		title: string;
		startsAt: string;
		endsAt: string;
		active: boolean;
	}

	let loaded = $state<MaintDraft[]>([]);
	let draft = $state<MaintDraft[]>([]);
	let overridden = $state(false);
	let updatedAt = $state<number | null>(null);
	let activeTitles = $state<Set<string>>(new Set());
	let services = $state<{ id: string; name: string }[]>([]);
	let loading = $state(true);
	let saving = $state(false);
	let editorOpen = $state(false);
	let editing = $state<MaintDraft | null>(null);
	let editingIdx = $state(-1);
	let deleteIdx = $state(-1);
	let deleteOpen = $state(false);

	const dirty = $derived(JSON.stringify(draft) !== JSON.stringify(loaded));

	async function load(): Promise<void> {
		try {
			const [sec, ov, svc] = await Promise.all([
				api<SectionView>('/sections/maintenance'),
				api<{ maintenance: { active: ActiveWindow[]; upcoming: ActiveWindow[] } }>('/overview'),
				api<{ value: { id: string; name: string }[] }>('/sections/services')
			]);
			loaded = Array.isArray(sec.value) ? sec.value : [];
			draft = structuredClone(loaded);
			overridden = sec.overridden;
			updatedAt = sec.updatedAt;
			activeTitles = new Set(ov.maintenance.active.map((w) => w.title));
			services = Array.isArray(svc.value) ? svc.value : [];
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'load failed');
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function openNew(): void {
		editing = null;
		editingIdx = -1;
		editorOpen = true;
	}
	function openEdit(i: number): void {
		editing = draft[i];
		editingIdx = i;
		editorOpen = true;
	}
	function onEditorSave(d: MaintDraft): void {
		if (editingIdx === -1) draft = [...draft, d];
		else draft = draft.map((w, i) => (i === editingIdx ? d : w));
		toast('info', 'Window saved; apply with Save');
	}

	function describe(w: MaintDraft): string {
		if (w.weekly) return `every ${w.weekly} ${w.at} UTC for ${w.duration_minutes}m`;
		return `${fmtDateTime(w.start ?? '')} - ${fmtDateTime(w.end ?? '')}`;
	}

	async function save(): Promise<void> {
		saving = true;
		try {
			await api('/sections/maintenance', {
				method: 'PUT',
				body: { value: draft, expected: updatedAt }
			});
			toast('success', 'Maintenance windows applied');
			await load();
		} catch (err) {
			toast('error', errMessage(err, 'save failed').slice(0, 400));
		} finally {
			saving = false;
		}
	}
</script>

<PageHeader title="Maintenance" description="Scheduled windows mark services as under maintenance">
	<SectionChip section="maintenance" {overridden} onreset={load} />
	<button class="btn btn-primary" onclick={openNew}><Plus class="size-4" /> Schedule</button>
</PageHeader>

{#if loading}
	<div class="card h-48 animate-pulse"></div>
{:else if draft.length === 0}
	<div class="card p-10 text-center">
		<CalendarClock class="mx-auto mb-3 size-8 text-faint" />
		<p class="text-muted">No maintenance windows scheduled.</p>
		<button class="btn btn-primary mt-4" onclick={openNew}
			><Plus class="size-4" /> Schedule one</button
		>
	</div>
{:else}
	<div class="card divide-y divide-edge">
		{#each draft as w, i (i)}
			<div class="flex items-center gap-3 px-4 py-3">
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-2">
						<span class="truncate text-sm font-medium">{w.title}</span>
						{#if w.weekly}<Repeat class="size-3.5 text-faint" />{/if}
						{#if activeTitles.has(w.title)}
							<span class="chip chip-on">active now</span>
						{/if}
					</div>
					<p class="mt-0.5 truncate text-xs text-faint">
						{describe(w)} · {w.services.includes('all') ? 'all services' : w.services.join(', ')}
					</p>
				</div>
				<div class="flex shrink-0 items-center gap-1">
					<button
						class="btn btn-ghost btn-sm"
						onclick={() => {
							openEdit(i);
						}}
						title="Edit"
					>
						<Pencil class="size-3.5" />
					</button>
					<button
						class="btn btn-ghost btn-sm text-down-fg"
						onclick={() => {
							deleteIdx = i;
							deleteOpen = true;
						}}
						title="Delete"
					>
						<Trash class="size-3.5" />
					</button>
				</div>
			</div>
		{/each}
	</div>
{/if}

<SaveBar {dirty} {saving} onsave={save} ondiscard={() => (draft = structuredClone(loaded))} />

<MaintenanceEditor bind:open={editorOpen} window_={editing} {services} onsave={onEditorSave} />

<ConfirmDialog
	bind:open={deleteOpen}
	title="Delete window?"
	description={`"${draft[deleteIdx]?.title ?? 'This window'}" will be removed.`}
	confirmLabel="Delete"
	danger
	onconfirm={() => {
		draft = draft.filter((_, i) => i !== deleteIdx);
		deleteIdx = -1;
	}}
/>
