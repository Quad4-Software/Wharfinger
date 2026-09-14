<script lang="ts">
	import { RotateCcw, Save } from '@lucide/svelte';

	const {
		dirty,
		saving = false,
		onsave,
		ondiscard
	}: {
		dirty: boolean;
		saving?: boolean;
		onsave: () => void;
		ondiscard: () => void;
	} = $props();
</script>

{#if dirty}
	<div
		class="card sticky bottom-4 z-40 mt-6 flex animate-rise flex-wrap items-center justify-between gap-3 border-accent/40 px-4 py-3 shadow-xl"
		role="region"
		aria-label="Unsaved changes"
	>
		<p class="text-sm text-muted">You have unsaved changes</p>
		<div class="flex flex-wrap gap-2">
			<button class="btn btn-ghost" onclick={ondiscard} disabled={saving}>
				<RotateCcw class="size-3.5" /> Discard
			</button>
			<button class="btn btn-primary" onclick={onsave} disabled={saving}>
				<Save class="size-3.5" />
				{saving ? 'Saving...' : 'Save changes'}
			</button>
		</div>
	</div>
{/if}
