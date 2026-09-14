<script lang="ts">
	import { ArrowLeft, ArrowRight, EyeOff, Minus, Plus } from '@lucide/svelte';
	import type { Snippet } from 'svelte';

	// One dashboard widget frame. In customize mode it gains a control
	// strip (reorder, span, hide); the parent owns layout state.
	const {
		title,
		span,
		customizing,
		first = false,
		last = false,
		onmove,
		onspan,
		onhide,
		children
	}: {
		title: string;
		span: number;
		customizing: boolean;
		first?: boolean;
		last?: boolean;
		onmove: (dir: -1 | 1) => void;
		onspan: (delta: -1 | 1) => void;
		onhide: () => void;
		children: Snippet;
	} = $props();

	const spanClass = $derived(
		(
			{
				1: 'lg:col-span-1',
				2: 'lg:col-span-2',
				3: 'lg:col-span-3',
				4: 'lg:col-span-4',
				5: 'lg:col-span-5',
				6: 'lg:col-span-6'
			} as Record<number, string>
		)[Math.min(6, Math.max(1, span))] ?? 'lg:col-span-2'
	);
</script>

<section class="card p-5 {spanClass} {customizing ? 'ring-1 ring-accent/40' : ''}">
	{#if customizing}
		<div class="mb-3 flex items-center justify-between gap-2 border-b border-edge pb-2">
			<span class="text-xs font-medium text-faint">{title}</span>
			<div class="flex items-center gap-0.5">
				<button
					class="btn btn-ghost !p-1"
					title="Move earlier"
					disabled={first}
					onclick={() => {
						onmove(-1);
					}}><ArrowLeft class="size-3.5" /></button
				>
				<button
					class="btn btn-ghost !p-1"
					title="Move later"
					disabled={last}
					onclick={() => {
						onmove(1);
					}}><ArrowRight class="size-3.5" /></button
				>
				<button
					class="btn btn-ghost !p-1"
					title="Narrower"
					disabled={span <= 1}
					onclick={() => {
						onspan(-1);
					}}><Minus class="size-3.5" /></button
				>
				<button
					class="btn btn-ghost !p-1"
					title="Wider"
					disabled={span >= 6}
					onclick={() => {
						onspan(1);
					}}><Plus class="size-3.5" /></button
				>
				<button class="btn btn-ghost !p-1" title="Hide" onclick={onhide}>
					<EyeOff class="size-3.5" />
				</button>
			</div>
		</div>
	{/if}
	{@render children()}
</section>
