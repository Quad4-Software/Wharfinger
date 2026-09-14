<script lang="ts">
	import { Dialog } from 'bits-ui';
	import { X } from '@lucide/svelte';
	import type { Snippet } from 'svelte';

	let {
		open = $bindable(false),
		title,
		wide = false,
		children
	}: {
		open?: boolean;
		title: string;
		wide?: boolean;
		children: Snippet;
	} = $props();
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Overlay class="fixed inset-0 z-50 animate-fade-in bg-black/60 backdrop-blur-[2px]" />
		<Dialog.Content
			class="card fixed left-1/2 top-1/2 z-50 max-h-[88vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-5 shadow-2xl {wide
				? 'max-w-2xl'
				: 'max-w-md'}"
		>
			<div class="mb-4 flex items-center justify-between gap-3">
				<Dialog.Title class="text-base font-semibold text-fg">{title}</Dialog.Title>
				<Dialog.Close class="rounded-md p-1 text-faint transition-colors hover:text-fg">
					<X class="size-4.5" />
				</Dialog.Close>
			</div>
			{@render children()}
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
