<script lang="ts">
	import type { DayBucket } from '$lib/shared/types';
	import { DAY_CLASS, DAY_LABEL } from '$lib/utils/status-style';
	import { fmtDate, fmtPct } from '$lib/utils/format';

	const { days }: { days: DayBucket[] } = $props();

	let hoverIdx = $state<number | null>(null);
	// Roving tabindex: one tab stop for the whole strip, arrows move
	// between days instead of tabbing through 90 separate bars.
	let focusIdx = $state(0);
	const barEls: (HTMLElement | null)[] = [];
	// Viewport coordinates: the tooltip uses position:fixed so it is never
	// clipped by the card's overflow:hidden, even on edge days.
	let tipX = $state(0);
	let tipY = $state(0);
	let tipEl = $state<HTMLDivElement | null>(null);
	let below = $state(false);

	function register(node: HTMLElement, i: number): { destroy(): void } {
		barEls[i] = node;
		return {
			destroy: () => {
				barEls[i] = null;
			}
		};
	}

	function show(e: PointerEvent | FocusEvent, i: number): void {
		hoverIdx = i;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		tipX = rect.left + rect.width / 2;
		tipY = rect.top;
	}

	function onkeydown(e: KeyboardEvent): void {
		if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
		e.preventDefault();
		const last = days.length - 1;
		const next =
			e.key === 'ArrowRight'
				? Math.min(last, focusIdx + 1)
				: e.key === 'ArrowLeft'
					? Math.max(0, focusIdx - 1)
					: e.key === 'Home'
						? 0
						: last;
		focusIdx = next;
		barEls[next]?.focus();
	}

	// Once mounted, clamp horizontally to the viewport and flip below the
	// bar when there is no room above.
	$effect(() => {
		if (!tipEl) return;
		const half = tipEl.offsetWidth / 2 + 8;
		const x = Math.min(Math.max(tipX, half), window.innerWidth - half);
		if (x !== tipX) tipX = x;
		below = tipY < tipEl.offsetHeight + 16;
	});

	// The card uses backdrop-filter, which makes it the containing block for
	// fixed descendants. Portaling to body keeps viewport coords honest.
	function portal(node: HTMLElement): { destroy(): void } {
		document.body.append(node);
		return {
			destroy: () => {
				node.remove();
			}
		};
	}

	const hovered = $derived(hoverIdx === null ? null : days[hoverIdx]);
</script>

<svelte:window
	onscroll={() => {
		hoverIdx = null;
	}}
/>

<!-- Roving tabindex: bars live inside a <button> trigger so they cannot be
     real buttons, but they still need keyboard focus to reveal tooltips. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	class="flex h-8 items-stretch gap-[2px]"
	role="list"
	aria-label="Daily uptime history"
	{onkeydown}
>
	{#each days as day, i (day.date)}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			use:register={i}
			role="listitem"
			tabindex={i === focusIdx ? 0 : -1}
			class="bar min-w-0 flex-1 rounded-[2px] {DAY_CLASS[day.state]}"
			aria-label="{day.date}: {DAY_LABEL[day.state]}{day.uptime !== null
				? `, ${fmtPct(day.uptime)} uptime`
				: ''}"
			onpointerenter={(e) => {
				show(e, i);
			}}
			onpointerleave={() => {
				hoverIdx = null;
			}}
			onfocus={(e) => {
				focusIdx = i;
				show(e, i);
			}}
			onblur={() => {
				hoverIdx = null;
			}}
		></div>
	{/each}
</div>

{#if hovered}
	<div
		use:portal
		bind:this={tipEl}
		class="pointer-events-none fixed z-50 -translate-x-1/2 rounded-lg border border-edge px-3 py-2 text-xs whitespace-nowrap shadow-xl backdrop-blur {below
			? 'translate-y-3'
			: '-translate-y-[calc(100%+10px)]'}"
		style="left: {tipX}px; top: {tipY}px; background: color-mix(in srgb, var(--color-panel) 95%, transparent)"
		role="tooltip"
	>
		<div class="font-medium text-fg">{fmtDate(hovered.date)}</div>
		<div class="mt-0.5 text-muted">
			{DAY_LABEL[hovered.state]}{hovered.uptime !== null ? ` · ${fmtPct(hovered.uptime)}` : ''}
		</div>
	</div>
{/if}
