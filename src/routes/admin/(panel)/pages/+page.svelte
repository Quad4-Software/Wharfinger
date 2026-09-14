<script lang="ts">
	import { onMount } from 'svelte';
	import { ExternalLink, Eye, EyeOff, Files, Pencil, Plus, Trash } from '@lucide/svelte';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import SectionChip from '$lib/components/admin/SectionChip.svelte';
	import SaveBar from '$lib/components/admin/SaveBar.svelte';
	import ConfirmDialog from '$lib/components/admin/ConfirmDialog.svelte';
	import PageEditor from '$lib/components/admin/PageEditor.svelte';
	import Modal from '$lib/components/admin/Modal.svelte';
	import StatusPage from '$lib/components/StatusPage.svelte';
	import type { PageDraft } from '$lib/shared/drafts';
	import type { PageMeta, StatusSnapshot } from '$lib/shared/types';
	import { api, ApiError, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import { paths } from '$lib/shared/paths';

	interface SectionView {
		value: PageDraft[];
		overridden: boolean;
		updatedAt: number | null;
	}

	let loaded = $state<PageDraft[]>([]);
	let draft = $state<PageDraft[]>([]);
	let overridden = $state(false);
	let updatedAt = $state<number | null>(null);
	let services = $state<{ id: string; name: string }[]>([]);
	let loading = $state(true);
	let saving = $state(false);
	let editorOpen = $state(false);
	let editing = $state<PageDraft | null>(null);
	let editingIdx = $state(-1);
	let deleteIdx = $state(-1);
	let deleteOpen = $state(false);
	let previewOpen = $state(false);
	let previewMeta = $state<PageMeta | null>(null);
	let previewSnap = $state<StatusSnapshot | null>(null);

	// Renders the real public page component with the draft (possibly
	// unsaved) page projected over the live snapshot; 'all' maps to '*'
	// exactly like the server-side snapshot builder.
	async function preview(p: PageDraft): Promise<void> {
		try {
			const res = await fetch(paths.apiStatus);
			if (!res.ok) throw new Error(`status ${res.status}`);
			previewSnap = (await res.json()) as StatusSnapshot;
			previewMeta = {
				slug: p.slug || 'preview',
				title: p.title,
				description: p.description ?? null,
				accent: p.accent ?? null,
				services: p.services.includes('all') ? ['*'] : p.services,
				noindex: p.noindex
			};
			previewOpen = true;
		} catch {
			toast('error', 'could not load the live snapshot for preview');
		}
	}

	const dirty = $derived(JSON.stringify(draft) !== JSON.stringify(loaded));

	async function load(): Promise<void> {
		try {
			const [sec, svc] = await Promise.all([
				api<SectionView>('/sections/pages'),
				api<{ value: { id: string; name: string }[] }>('/sections/services')
			]);
			loaded = Array.isArray(sec.value) ? sec.value : [];
			draft = structuredClone(loaded);
			overridden = sec.overridden;
			updatedAt = sec.updatedAt;
			services = Array.isArray(svc.value) ? svc.value : [];
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'load failed');
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function onEditorSave(d: PageDraft): void {
		if (editingIdx === -1) draft = [...draft, d];
		else draft = draft.map((p, i) => (i === editingIdx ? d : p));
		toast('info', 'Page saved; apply with Save');
	}

	async function save(): Promise<void> {
		saving = true;
		try {
			await api('/sections/pages', { method: 'PUT', body: { value: draft, expected: updatedAt } });
			toast('success', 'Pages applied');
			await load();
		} catch (err) {
			toast('error', errMessage(err, 'save failed').slice(0, 400));
		} finally {
			saving = false;
		}
	}
</script>

<PageHeader title="Pages" description="Named status pages served at /p/<slug>">
	<SectionChip section="pages" {overridden} onreset={load} />
	<button
		class="btn btn-primary"
		onclick={() => {
			editing = null;
			editingIdx = -1;
			editorOpen = true;
		}}
	>
		<Plus class="size-4" /> Add page
	</button>
</PageHeader>

{#if loading}
	<div class="card h-48 animate-pulse"></div>
{:else if draft.length === 0}
	<div class="card p-10 text-center">
		<Files class="mx-auto mb-3 size-8 text-faint" />
		<p class="text-muted">No extra pages. The root page always shows everything.</p>
		<button
			class="btn btn-primary mt-4"
			onclick={() => {
				editing = null;
				editingIdx = -1;
				editorOpen = true;
			}}
		>
			<Plus class="size-4" /> Add a page
		</button>
	</div>
{:else}
	<div class="card divide-y divide-edge">
		{#each draft as p, i (p.slug || i)}
			<div class="flex items-center gap-3 px-4 py-3">
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-2">
						<span class="truncate text-sm font-medium">{p.title}</span>
						{#if p.noindex}<EyeOff class="size-3.5 text-faint" />{/if}
						{#if p.accent}
							<span class="size-3 rounded-full" style:background={p.accent}></span>
						{/if}
					</div>
					<p class="mt-0.5 truncate font-mono text-xs text-faint">
						/p/{p.slug} · {p.services.includes('all') ? 'all services' : p.services.join(', ')}
					</p>
				</div>
				<div class="flex shrink-0 items-center gap-1">
					<button
						class="btn btn-ghost btn-sm"
						title="Preview draft"
						onclick={() => void preview(p)}
					>
						<Eye class="size-3.5" />
					</button>
					<a class="btn btn-ghost btn-sm" href="/p/{p.slug}" target="_blank" title="Open">
						<ExternalLink class="size-3.5" />
					</a>
					<button
						class="btn btn-ghost btn-sm"
						title="Edit"
						onclick={() => {
							editing = p;
							editingIdx = i;
							editorOpen = true;
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
{/if}

<SaveBar {dirty} {saving} onsave={save} ondiscard={() => (draft = structuredClone(loaded))} />

<PageEditor
	bind:open={editorOpen}
	page_={editing}
	existingSlugs={draft.map((p) => p.slug)}
	{services}
	onsave={onEditorSave}
/>

<Modal bind:open={previewOpen} title={`Preview: /p/${previewMeta?.slug ?? ''}`} wide>
	{#if previewSnap && previewMeta}
		<p class="mb-3 text-xs text-faint">
			Draft preview over live data. Unsaved changes appear here before you apply them.
		</p>
		<div class="max-h-[70vh] overflow-y-auto rounded-lg border border-edge">
			<StatusPage snapshot={previewSnap} page={previewMeta} />
		</div>
	{/if}
</Modal>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Delete page?"
	description={`"/p/${draft[deleteIdx]?.slug ?? ''}" will stop serving.`}
	confirmLabel="Delete"
	danger
	onconfirm={() => {
		draft = draft.filter((_, i) => i !== deleteIdx);
		deleteIdx = -1;
	}}
/>
