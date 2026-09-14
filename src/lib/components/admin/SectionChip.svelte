<script lang="ts">
	import { RotateCcw } from '@lucide/svelte';
	import { api, ApiError } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';

	// "Customized" chip shown when a config section has a runtime override,
	// with one-click reset back to the file value.
	const {
		section,
		overridden,
		onreset
	}: {
		section: string;
		overridden: boolean;
		onreset?: () => void;
	} = $props();

	let confirmOpen = $state(false);

	async function reset(): Promise<void> {
		try {
			await api(`/sections/${section}`, { method: 'DELETE' });
			toast('success', 'Section reset to file config');
			onreset?.();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'reset failed');
		}
	}
</script>

{#if overridden}
	<span class="chip chip-on">customized</span>
	<button
		class="btn btn-ghost btn-sm"
		title="Reset to file config"
		onclick={() => (confirmOpen = true)}
	>
		<RotateCcw class="size-3.5" /> Reset
	</button>
	<ConfirmDialog
		bind:open={confirmOpen}
		title="Reset to file config?"
		description="The runtime override for this section will be removed and the value from wharfinger.toml restored."
		confirmLabel="Reset"
		onconfirm={reset}
	/>
{/if}
