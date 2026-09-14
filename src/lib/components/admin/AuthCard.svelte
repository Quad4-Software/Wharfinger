<script lang="ts">
	import { ShieldCheck } from '@lucide/svelte';
	import type { Snippet } from 'svelte';

	const {
		title,
		subtitle = null,
		children
	}: { title: string; subtitle?: string | null; children: Snippet } = $props();
</script>

<div class="flex min-h-screen items-center justify-center px-4">
	<div class="card w-full max-w-sm p-6">
		<div class="mb-5 flex items-center gap-2.5">
			<ShieldCheck class="size-5 text-accent" />
			<div>
				<h1 class="text-base font-semibold leading-tight">{title}</h1>
				{#if subtitle}<p class="text-xs text-faint">{subtitle}</p>{/if}
			</div>
		</div>
		{@render children()}
	</div>
</div>
