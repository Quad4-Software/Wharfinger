<script lang="ts">
	import { AlertDialog } from 'bits-ui';

	let {
		open = $bindable(false),
		title,
		description,
		confirmLabel = 'Confirm',
		danger = false,
		onconfirm
	}: {
		open?: boolean;
		title: string;
		description: string;
		confirmLabel?: string;
		danger?: boolean;
		onconfirm: () => void;
	} = $props();
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Portal>
		<AlertDialog.Overlay
			class="fixed inset-0 z-50 animate-fade-in bg-black/60 backdrop-blur-[2px]"
		/>
		<AlertDialog.Content
			class="card fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 p-5 shadow-2xl"
		>
			<AlertDialog.Title class="text-base font-semibold text-fg">{title}</AlertDialog.Title>
			<AlertDialog.Description class="mt-2 text-sm leading-relaxed text-muted">
				{description}
			</AlertDialog.Description>
			<div class="mt-5 flex justify-end gap-2">
				<AlertDialog.Cancel class="btn">Cancel</AlertDialog.Cancel>
				<AlertDialog.Action class="btn {danger ? 'btn-danger' : 'btn-primary'}" onclick={onconfirm}>
					{confirmLabel}
				</AlertDialog.Action>
			</div>
		</AlertDialog.Content>
	</AlertDialog.Portal>
</AlertDialog.Root>
