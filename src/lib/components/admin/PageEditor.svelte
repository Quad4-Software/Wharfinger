<script lang="ts">
	import Field from './Field.svelte';
	import Modal from './Modal.svelte';
	import ServicePicker from './ServicePicker.svelte';
	import type { PageDraft } from '$lib/shared/drafts';

	let {
		open = $bindable(false),
		page_,
		existingSlugs,
		services,
		onsave
	}: {
		open?: boolean;
		page_: PageDraft | null;
		existingSlugs: string[];
		services: { id: string; name: string }[];
		onsave: (draft: PageDraft) => void;
	} = $props();

	let slug = $state('');
	let title = $state('');
	let description = $state('');
	let accent = $state('');
	let noindex = $state(false);
	let selected = $state<string[]>([]);
	let error = $state<string | null>(null);

	$effect(() => {
		if (open) {
			slug = page_?.slug ?? '';
			title = page_?.title ?? '';
			description = page_?.description ?? '';
			accent = page_?.accent ?? '';
			noindex = page_?.noindex ?? false;
			selected = page_?.services ? [...page_.services] : [];
			error = null;
		}
	});

	const isNew = $derived(page_ === null);

	function submit(): void {
		error = null;
		if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
			error = 'slug must be lowercase letters, digits, and dashes';
			return;
		}
		if (isNew && existingSlugs.includes(slug)) {
			error = 'that slug is already in use';
			return;
		}
		if (!title.trim()) {
			error = 'title is required';
			return;
		}
		if (selected.length === 0) {
			error = 'select at least one service';
			return;
		}
		if (accent && !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(accent)) {
			error = 'accent must be a hex color like #10b981';
			return;
		}
		const out: PageDraft = {
			slug: slug.trim(),
			title: title.trim(),
			services: selected
		};
		if (description.trim()) out.description = description.trim();
		if (accent) out.accent = accent;
		if (noindex) out.noindex = true;
		onsave(out);
		open = false;
	}
</script>

<Modal bind:open title={isNew ? 'Add page' : `Edit ${page_?.title ?? 'page'}`} wide>
	<form
		class="space-y-4"
		onsubmit={(e) => {
			e.preventDefault();
			submit();
		}}
	>
		<div class="grid grid-cols-2 gap-3">
			<Field label="Slug" required hint={isNew ? 'Served at /p/<slug>.' : 'Slugs cannot change.'}>
				<input class="input font-mono" bind:value={slug} disabled={!isNew} required />
			</Field>
			<Field label="Title" required>
				<input class="input" bind:value={title} required />
			</Field>
		</div>
		<Field label="Description">
			<input class="input" bind:value={description} />
		</Field>
		<div class="grid grid-cols-2 gap-3">
			<Field label="Accent" hint="Hex color, e.g. #38bdf8.">
				<input class="input font-mono" bind:value={accent} placeholder="#10b981" />
			</Field>
			<div class="flex items-end pb-2">
				<label class="flex items-center gap-2 text-sm text-muted">
					<input type="checkbox" bind:checked={noindex} /> Keep out of search engines
				</label>
			</div>
		</div>
		<Field label="Services on this page" required>
			<ServicePicker {services} bind:selected />
		</Field>
		{#if error}<p class="text-sm text-down-fg" role="alert">{error}</p>{/if}
		<div class="flex justify-end gap-2 pt-1">
			<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
			<button type="submit" class="btn btn-primary">{isNew ? 'Add page' : 'Save'}</button>
		</div>
	</form>
</Modal>
