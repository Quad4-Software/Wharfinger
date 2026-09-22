<script lang="ts">
	// Switch control: a real button with role="switch" so it is
	// keyboard operable and announced correctly. Binds `checked`.
	let {
		checked = $bindable(false),
		label,
		hint,
		disabled = false,
		onchange
	}: {
		checked?: boolean;
		label: string;
		hint?: string;
		disabled?: boolean;
		onchange?: (checked: boolean) => void;
	} = $props();

	function flip(): void {
		checked = !checked;
		onchange?.(checked);
	}
</script>

<button
	type="button"
	role="switch"
	aria-checked={checked}
	aria-label={label}
	{disabled}
	class="group flex items-start gap-3 text-left disabled:opacity-50"
	onclick={flip}
>
	<span
		class="relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors {checked
			? 'border-accent bg-accent'
			: 'border-edge bg-panel group-hover:border-faint'}"
	>
		<span
			class="absolute left-0.5 size-3.5 rounded-full transition-transform {checked
				? 'translate-x-4 bg-white'
				: 'translate-x-0 bg-muted'}"
		></span>
	</span>
	<span class="min-w-0">
		<span class="block text-sm {checked ? 'text-fg' : 'text-muted'}">{label}</span>
		{#if hint}<span class="mt-0.5 block text-xs text-faint">{hint}</span>{/if}
	</span>
</button>
