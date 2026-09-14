<script lang="ts">
	import { onMount } from 'svelte';
	import { Eye, Plus, RotateCcw, Trash } from '@lucide/svelte';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import SectionChip from '$lib/components/admin/SectionChip.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import { api, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';

	// Status page customizer: branding, page behavior, and header links
	// with a live preview of the public page. Writes go through the same
	// /sections API as the settings page, so overrides and optimistic
	// concurrency behave identically.

	type Dict = Record<string, unknown>;
	interface View {
		value: unknown;
		overridden: boolean;
		updatedAt: number | null;
	}
	const KEYS = ['site', 'page', 'links'] as const;
	type Key = (typeof KEYS)[number];

	const secs = $state<
		Record<
			Key,
			{
				loaded: unknown;
				draft: unknown;
				overridden: boolean;
				updatedAt: number | null;
				saving: boolean;
			}
		>
	>({
		site: { loaded: {}, draft: {}, overridden: false, updatedAt: null, saving: false },
		page: { loaded: {}, draft: {}, overridden: false, updatedAt: null, saving: false },
		links: { loaded: [], draft: [], overridden: false, updatedAt: null, saving: false }
	});

	let loading = $state(true);
	let previewKey = $state(0);

	function site(): Dict {
		return secs.site.draft as Dict;
	}
	function pageSec(): Dict {
		return secs.page.draft as Dict;
	}
	function links(): { label: string; href: string }[] {
		return secs.links.draft as { label: string; href: string }[];
	}
	function str(d: Dict, k: string, fallback = ''): string {
		const v = d[k];
		if (typeof v === 'string') return v;
		if (typeof v === 'number' || typeof v === 'boolean') return String(v);
		return fallback;
	}
	function patch(k: Key, p: Dict): void {
		secs[k].draft = { ...(secs[k].draft as Dict), ...p };
	}
	function dirty(k: Key): boolean {
		return JSON.stringify(secs[k].draft) !== JSON.stringify(secs[k].loaded);
	}
	const anyDirty = $derived(KEYS.some(dirty));

	async function load(): Promise<void> {
		try {
			const results = await Promise.all(KEYS.map((k) => api<View>(`/sections/${k}`)));
			KEYS.forEach((k, i) => {
				const v = results[i].value ?? (k === 'links' ? [] : {});
				secs[k] = {
					loaded: structuredClone(v),
					draft: structuredClone(v),
					overridden: results[i].overridden,
					updatedAt: results[i].updatedAt,
					saving: false
				};
			});
		} catch (err) {
			toast('error', errMessage(err, 'load failed'));
		} finally {
			loading = false;
		}
	}

	onMount(load);

	async function save(k: Key): Promise<void> {
		secs[k].saving = true;
		try {
			const r = await api<{ overridden: boolean; updatedAt: number | null }>(`/sections/${k}`, {
				method: 'PUT',
				body: { value: secs[k].draft, expected: secs[k].updatedAt }
			});
			secs[k].loaded = structuredClone(secs[k].draft);
			secs[k].overridden = r.overridden;
			secs[k].updatedAt = r.updatedAt;
			previewKey++;
			toast('success', `${k} applied`);
		} catch (err) {
			toast('error', errMessage(err, 'save failed').slice(0, 400));
		} finally {
			secs[k].saving = false;
		}
	}

	async function saveAll(): Promise<void> {
		for (const k of KEYS) {
			if (dirty(k)) await save(k);
		}
	}

	function addLink(): void {
		secs.links.draft = [...links(), { label: '', href: 'https://' }];
	}
	function removeLink(i: number): void {
		secs.links.draft = links().filter((_, j) => j !== i);
	}

	const ACCENTS = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6'];
</script>

<PageHeader title="Customize" description="Branding and behavior of the public status page.">
	<button class="btn btn-ghost" onclick={load} disabled={loading} aria-label="Reload">
		<RotateCcw class="size-4 {loading ? 'animate-spin' : ''}" />
	</button>
	<button class="btn btn-primary" onclick={saveAll} disabled={!anyDirty}> Apply changes </button>
</PageHeader>

{#if loading}
	<div class="grid gap-6 xl:grid-cols-2">
		<div class="card h-80 animate-pulse"></div>
		<div class="card h-80 animate-pulse"></div>
	</div>
{:else}
	<div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
		<div class="space-y-6">
			<section class="card p-5">
				<div class="mb-4 flex items-center justify-between">
					<h2 class="text-sm font-semibold">Site identity</h2>
					<SectionChip section="site" overridden={secs.site.overridden} onreset={load} />
				</div>
				<div class="space-y-4">
					<Field label="Site name" required>
						<input
							class="input w-full"
							value={str(site(), 'name')}
							oninput={(e) => {
								patch('site', { name: e.currentTarget.value });
							}}
							required
						/>
					</Field>
					<Field label="Page title" hint="Browser tab title; defaults to the site name.">
						<input
							class="input w-full"
							value={str(site(), 'title')}
							oninput={(e) => {
								patch('site', { title: e.currentTarget.value });
							}}
						/>
					</Field>
					<Field label="Description" hint="Shown under the name and in meta tags.">
						<textarea
							class="input w-full"
							rows="2"
							oninput={(e) => {
								patch('site', { description: e.currentTarget.value });
							}}>{str(site(), 'description')}</textarea
						>
					</Field>
					<div class="grid gap-4 sm:grid-cols-2">
						<Field label="Site URL" hint="Canonical URL for RSS/SEO.">
							<input
								class="input w-full"
								type="url"
								value={str(site(), 'url')}
								oninput={(e) => {
									patch('site', { url: e.currentTarget.value });
								}}
								placeholder="https://status.example.com"
							/>
						</Field>
						<Field label="Logo URL" hint="Rendered in the header.">
							<input
								class="input w-full"
								type="url"
								value={str(site(), 'logo_url')}
								oninput={(e) => {
									patch('site', { logo_url: e.currentTarget.value });
								}}
								placeholder="https://.../logo.svg"
							/>
						</Field>
					</div>
					<Field label="Accent color">
						<div class="flex flex-wrap items-center gap-2">
							{#each ACCENTS as c (c)}
								<button
									class="size-7 rounded-full border-2 transition-transform {site().accent === c
										? 'scale-110 border-fg'
										: 'border-transparent'}"
									style="background:{c}"
									onclick={() => {
										patch('site', { accent: c });
									}}
									aria-label="accent {c}"
								></button>
							{/each}
							<input
								class="h-7 w-14 cursor-pointer rounded border border-edge bg-transparent"
								type="color"
								value={str(site(), 'accent', '#10b981')}
								oninput={(e) => {
									patch('site', { accent: e.currentTarget.value });
								}}
								aria-label="custom accent"
							/>
						</div>
					</Field>
					<div class="grid gap-4 sm:grid-cols-[1fr_auto]">
						<Field label="Announcement" hint="Optional banner at the top of the page.">
							<input
								class="input w-full"
								value={str(site(), 'announcement')}
								oninput={(e) => {
									patch('site', { announcement: e.currentTarget.value });
								}}
								placeholder="e.g. Scheduled maintenance this weekend"
							/>
						</Field>
						<Field label="Severity">
							<select
								class="input"
								value={str(site(), 'announcement_severity', 'info')}
								onchange={(e) => {
									patch('site', { announcement_severity: e.currentTarget.value });
								}}
							>
								<option value="info">info</option>
								<option value="warning">warning</option>
								<option value="critical">critical</option>
							</select>
						</Field>
					</div>
					<div class="flex justify-end">
						<button
							class="btn btn-primary"
							onclick={() => save('site')}
							disabled={secs.site.saving || !dirty('site')}
						>
							{secs.site.saving ? 'Saving…' : 'Save site'}
						</button>
					</div>
				</div>
			</section>

			<section class="card p-5">
				<div class="mb-4 flex items-center justify-between">
					<h2 class="text-sm font-semibold">Page behavior</h2>
					<SectionChip section="page" overridden={secs.page.overridden} onreset={load} />
				</div>
				<div class="grid gap-4 sm:grid-cols-3">
					<Field label="Refresh (seconds)">
						<input
							class="input w-full"
							type="number"
							min="5"
							max="3600"
							value={Number(pageSec().refresh_seconds ?? 30)}
							oninput={(e) => {
								patch('page', { refresh_seconds: Number(e.currentTarget.value) });
							}}
						/>
					</Field>
					<Field label="History (days)">
						<input
							class="input w-full"
							type="number"
							min="7"
							max="365"
							value={Number(pageSec().history_days ?? 90)}
							oninput={(e) => {
								patch('page', { history_days: Number(e.currentTarget.value) });
							}}
						/>
					</Field>
					<Field label="Uptime legend">
						<select
							class="input w-full"
							value={str(pageSec(), 'show_uptime_legend', 'true')}
							onchange={(e) => {
								patch('page', { show_uptime_legend: e.currentTarget.value === 'true' });
							}}
						>
							<option value="true">show</option>
							<option value="false">hide</option>
						</select>
					</Field>
				</div>
				<div class="mt-4 flex justify-end">
					<button
						class="btn btn-primary"
						onclick={() => save('page')}
						disabled={secs.page.saving || !dirty('page')}
					>
						{secs.page.saving ? 'Saving…' : 'Save page'}
					</button>
				</div>
			</section>

			<section class="card p-5">
				<div class="mb-4 flex items-center justify-between">
					<h2 class="text-sm font-semibold">Header links</h2>
					<div class="flex items-center gap-2">
						<SectionChip section="links" overridden={secs.links.overridden} onreset={load} />
						<button class="btn btn-ghost !px-2 !py-1" onclick={addLink}
							><Plus class="size-4" /> Link</button
						>
					</div>
				</div>
				<div class="space-y-2">
					{#each links() as link, i (i)}
						<div class="flex gap-2">
							<input
								class="input w-40"
								placeholder="Label"
								value={link.label}
								oninput={(e) => {
									const l = links();
									l[i] = { ...l[i], label: e.currentTarget.value };
									secs.links.draft = l;
								}}
							/>
							<input
								class="input min-w-0 flex-1"
								placeholder="https://…"
								value={link.href}
								oninput={(e) => {
									const l = links();
									l[i] = { ...l[i], href: e.currentTarget.value };
									secs.links.draft = l;
								}}
							/>
							<button
								class="btn btn-ghost shrink-0"
								onclick={() => {
									removeLink(i);
								}}
								aria-label="Remove link"><Trash class="size-4" /></button
							>
						</div>
					{/each}
					{#if links().length === 0}<p class="text-xs text-faint">No links yet.</p>{/if}
				</div>
				<div class="mt-4 flex justify-end">
					<button
						class="btn btn-primary"
						onclick={() => save('links')}
						disabled={secs.links.saving || !dirty('links')}
					>
						{secs.links.saving ? 'Saving…' : 'Save links'}
					</button>
				</div>
			</section>
		</div>

		<div class="card sticky top-6 h-fit overflow-hidden p-0">
			<div class="flex items-center gap-2 border-b border-edge px-3 py-2 text-xs text-faint">
				<Eye class="size-3.5" /> Live preview — refreshes on save
				<button class="ml-auto btn btn-ghost !px-2 !py-0.5 text-xs" onclick={() => previewKey++}
					>reload</button
				>
			</div>
			{#key previewKey}
				<iframe
					src="/?preview={previewKey}"
					title="Status page preview"
					class="h-[70vh] w-full border-0 bg-bg"
				></iframe>
			{/key}
		</div>
	</div>
{/if}
