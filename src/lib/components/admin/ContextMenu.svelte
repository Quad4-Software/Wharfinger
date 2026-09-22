<script lang="ts" module>
	import type { Component } from 'svelte';

	export interface CtxItem {
		label: string;
		icon?: Component;
		danger?: boolean;
		disabled?: boolean;
		action: () => void;
	}
</script>

<script lang="ts">
	import { onMount, tick } from 'svelte';

	const {
		x,
		y,
		items,
		onclose
	}: {
		x: number;
		y: number;
		items: CtxItem[];
		onclose: () => void;
	} = $props();

	let menuEl = $state<HTMLDivElement | null>(null);
	let left = $state(0);
	let top = $state(0);

	function pick(item: CtxItem): void {
		onclose();
		if (!item.disabled) item.action();
	}

	function buttons(): HTMLButtonElement[] {
		if (!menuEl) return [];
		return [...menuEl.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
	}

	function onKey(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			onclose();
			return;
		}
		const btns = buttons();
		if (btns.length === 0) return;
		const i = btns.indexOf(document.activeElement as HTMLButtonElement);
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			btns[(i + 1) % btns.length].focus();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			btns[(i - 1 + btns.length) % btns.length].focus();
		} else if (e.key === 'Home' || e.key === 'End') {
			e.preventDefault();
			(e.key === 'Home' ? btns[0] : btns[btns.length - 1]).focus();
		}
	}

	function onPointerDown(e: PointerEvent): void {
		if (menuEl && e.target instanceof Node && !menuEl.contains(e.target)) onclose();
	}

	// Scroll events do not bubble, so capture sees every scroller. Keep
	// the menu open only for scrolls inside the menu itself.
	function onScroll(e: Event): void {
		if (menuEl && e.target instanceof Node && menuEl.contains(e.target)) return;
		onclose();
	}

	onMount(() => {
		left = x;
		top = y;
		void tick().then(() => {
			if (!menuEl) return;
			const r = menuEl.getBoundingClientRect();
			left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
			top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
			menuEl.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
		});
		window.addEventListener('pointerdown', onPointerDown, true);
		window.addEventListener('keydown', onKey, true);
		window.addEventListener('scroll', onScroll, true);
		window.addEventListener('resize', onclose);
		return () => {
			window.removeEventListener('pointerdown', onPointerDown, true);
			window.removeEventListener('keydown', onKey, true);
			window.removeEventListener('scroll', onScroll, true);
			window.removeEventListener('resize', onclose);
		};
	});
</script>

<div
	bind:this={menuEl}
	class="animate-rise fixed z-[80] max-h-[70vh] min-w-44 max-w-64 overflow-y-auto rounded-lg border border-edge bg-raised py-1 shadow-2xl"
	style="left: {left}px; top: {top}px"
	role="menu"
	tabindex="-1"
	aria-orientation="vertical"
	oncontextmenu={(e) => {
		e.preventDefault();
	}}
>
	{#each items as item, i (i)}
		{@const Icon = item.icon}
		<button
			type="button"
			role="menuitem"
			class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 {item.danger
				? 'text-down-fg hover:bg-down/10'
				: 'text-fg hover:bg-panel'}"
			disabled={item.disabled}
			onclick={() => {
				pick(item);
			}}
		>
			{#if Icon}<Icon class="size-3.5 shrink-0" />{/if}
			<span class="truncate">{item.label}</span>
		</button>
	{/each}
</div>
