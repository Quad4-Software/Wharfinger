<script lang="ts">
	import { onMount } from 'svelte';
	import { parse } from 'smol-toml';
	import { CircleCheck, CircleX, RotateCcwClock } from '@lucide/svelte';
	import SaveBar from './SaveBar.svelte';
	import { api, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import { relativeTime } from '$lib/utils/format';

	// Whole-document config editor. Lints the TOML locally on every
	// edit and lists saved revisions for one-click load-back into the
	// buffer; applying still goes through the normal save path.
	let {
		toml = $bindable(''),
		dirty = false,
		saving = false,
		onsave,
		ondiscard
	}: {
		toml?: string;
		dirty?: boolean;
		saving?: boolean;
		onsave: () => void;
		ondiscard: () => void;
	} = $props();

	interface Revision {
		id: number;
		author: string | null;
		at: number;
	}

	let lintError = $state<string | null>(null);
	let lintTimer: ReturnType<typeof setTimeout> | undefined;
	let revisions = $state<Revision[]>([]);
	let historyOpen = $state(false);
	let loadingRev = $state<number | null>(null);

	const lines = $derived(toml === '' ? 0 : toml.split('\n').length);

	function lint(text: string): void {
		clearTimeout(lintTimer);
		lintTimer = setTimeout(() => {
			if (!text.trim()) {
				lintError = null;
				return;
			}
			try {
				parse(text);
				lintError = null;
			} catch (err) {
				lintError = (err as Error).message;
			}
		}, 250);
	}

	async function loadRevisions(): Promise<void> {
		try {
			const r = await api<{ revisions: Revision[] }>('/config/history');
			revisions = r.revisions;
		} catch {
			// History is best-effort; the editor still works without it.
		}
	}

	async function loadRevision(id: number): Promise<void> {
		if (loadingRev !== null) return;
		loadingRev = id;
		try {
			const r = await api<{ doc: string }>(`/config/history?id=${id}`);
			toml = r.doc;
			lint(toml);
			toast('info', 'Revision loaded into the editor. Review and save to apply.');
		} catch (err) {
			toast('error', errMessage(err, 'could not load revision'));
		} finally {
			loadingRev = null;
		}
	}

	onMount(() => {
		void loadRevisions();
		return () => {
			clearTimeout(lintTimer);
		};
	});
</script>

<textarea
	class="input h-72 w-full font-mono text-xs leading-5 {lintError ? '!border-down/60' : ''}"
	bind:value={toml}
	oninput={() => {
		lint(toml);
	}}
	spellcheck="false"
	aria-label="Config document"
	aria-invalid={lintError !== null}></textarea>

<div class="mt-2 flex items-start justify-between gap-3 text-xs" aria-live="polite">
	{#if lintError}
		<p class="flex items-start gap-1.5 text-down-fg">
			<CircleX class="mt-0.5 size-3.5 shrink-0" />
			<span class="font-mono">{lintError}</span>
		</p>
	{:else if toml.trim()}
		<p class="flex items-center gap-1.5 text-faint">
			<CircleCheck class="size-3.5 text-up" /> valid TOML, {lines} lines
		</p>
	{:else}
		<p class="text-faint">empty document</p>
	{/if}
	<button
		class="btn btn-ghost btn-sm shrink-0"
		aria-expanded={historyOpen}
		onclick={() => {
			historyOpen = !historyOpen;
			if (historyOpen) void loadRevisions();
		}}
	>
		<RotateCcwClock class="size-3.5" /> Versions
	</button>
</div>

{#if historyOpen}
	<div class="mt-2 rounded-lg border border-edge">
		{#if revisions.length === 0}
			<p class="px-3 py-3 text-xs text-faint">No saved revisions yet.</p>
		{:else}
			<ul class="divide-y divide-edge/60">
				{#each revisions as r (r.id)}
					<li class="flex items-center gap-2 px-3 py-1.5 text-xs">
						<span class="font-mono text-faint">v{r.id}</span>
						<span class="text-muted">{relativeTime(r.at)}</span>
						<span class="text-faint">{r.author ?? 'unknown'}</span>
						<button
							class="btn btn-ghost btn-sm ml-auto"
							disabled={loadingRev !== null}
							onclick={() => {
								void loadRevision(r.id);
							}}
						>
							{loadingRev === r.id ? 'Loading...' : 'Load'}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}

<SaveBar {dirty} {saving} {onsave} {ondiscard} />
