<script lang="ts">
	import { Activity, Bell, MessageSquare, Send, TriangleAlert } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { adminHref, api } from '$lib/state/admin.svelte';
	import {
		notifyLocal,
		pushEnabled,
		pushPermission,
		pushSupported,
		requestPushPermission,
		syncPushSubscription,
		unsubscribePush
	} from '$lib/state/push-notify.svelte';
	import type { NotifyFeedItem } from '$lib/shared/types';

	const { userId }: { userId: number } = $props();

	const seenKey = $derived(`wf-notify-seen:${userId}`);
	const POLL_MS = 30_000;

	let open = $state(false);
	let items = $state<NotifyFeedItem[]>([]);
	let failed = $state(false);
	let seen = $state(0);
	let pushBusy = $state(false);
	let btnEl = $state<HTMLButtonElement | null>(null);
	let menuX = $state(0);
	let menuY = $state(0);
	const MENU_W = 320;

	function loadSeen(): number {
		try {
			return Number(localStorage.getItem(seenKey) ?? 0) || 0;
		} catch {
			return 0;
		}
	}

	const unread = $derived(items.filter((i) => i.at > seen).length);

	// Newest timestamp seen by the last poll; the first fetch primes
	// it so a busy feed does not burst local notifications on load.
	let lastFetchMax = 0;
	let primed = false;

	async function refresh(): Promise<void> {
		try {
			const d = await api<{ items: NotifyFeedItem[] }>('/notifications');
			items = d.items;
			failed = false;
			const max = items.reduce((m, i) => Math.max(m, i.at), 0);
			if (primed && max > lastFetchMax && !open && pushEnabled()) {
				const item = items.find((i) => i.at === max) ?? items[0];
				notifyLocal(item.title, item.sub ?? '');
			}
			primed = true;
			lastFetchMax = max;
		} catch {
			failed = true;
		}
	}

	function markAllRead(): void {
		seen = Date.now();
		try {
			localStorage.setItem(seenKey, String(seen));
		} catch {
			// storage unavailable; the badge just returns next load
		}
	}

	function toggle(): void {
		open = !open;
		if (open) {
			// Right-align to the button, clamped to the viewport so the
			// menu never overflows off-screen from the sidebar mount.
			const r = btnEl?.getBoundingClientRect();
			if (r) {
				menuX = Math.min(
					Math.max(8, r.right - MENU_W),
					Math.max(8, window.innerWidth - MENU_W - 8)
				);
				menuY = r.bottom + 8;
			}
			void refresh();
		}
	}

	function close(): void {
		if (!open) return;
		open = false;
		// Viewing the panel acknowledges everything it showed.
		if (items.length > 0 && items[0].at > seen) markAllRead();
	}

	function kindIcon(kind: NotifyFeedItem['kind']) {
		switch (kind) {
			case 'chat':
				return MessageSquare;
			case 'incident':
				return TriangleAlert;
			case 'delivery':
				return Send;
			default:
				return Activity;
		}
	}

	function ago(at: number): string {
		const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
		if (s < 60) return 'just now';
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m ago`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h ago`;
		return `${Math.floor(h / 24)}d ago`;
	}

	function pushLabel(): string {
		if (!pushSupported()) return 'not supported by this browser';
		if (pushPermission() === 'denied') return 'blocked by the browser';
		return pushEnabled() ? 'enabled on this browser' : 'off';
	}

	async function togglePush(): Promise<void> {
		if (pushBusy || !pushSupported() || pushPermission() === 'denied') return;
		pushBusy = true;
		try {
			if (pushEnabled()) {
				await unsubscribePush();
			} else {
				await requestPushPermission();
			}
		} catch {
			// state helpers already map failures to their flags
		}
		pushBusy = false;
	}

	onMount(() => {
		seen = loadSeen();
		void refresh();
		void syncPushSubscription();
		const t = setInterval(() => {
			void refresh();
		}, POLL_MS);
		return () => {
			clearInterval(t);
		};
	});
</script>

<svelte:window
	onkeydown={(e: KeyboardEvent) => {
		if (e.key === 'Escape') close();
	}}
/>

<div class="relative">
	<button
		bind:this={btnEl}
		class="relative rounded-md p-1.5 text-muted hover:text-fg"
		onclick={toggle}
		aria-label="Notifications"
		aria-expanded={open}
	>
		<Bell class="size-5" />
		{#if unread > 0}
			<span
				class="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-down px-1 text-[10px] font-semibold text-white"
				aria-label="{unread} new notifications"
			>
				{unread > 9 ? '9+' : unread}
			</span>
		{/if}
	</button>

	{#if open}
		<button
			class="fixed inset-0 z-40 cursor-default"
			onclick={close}
			aria-label="Close notifications"
			tabindex="-1"
		></button>
		<div
			class="thin-scroll fixed z-50 max-h-96 w-80 overflow-y-auto rounded-xl border border-edge bg-panel shadow-xl"
			style="left: {menuX}px; top: {menuY}px"
			role="dialog"
			aria-label="Notifications"
		>
			<div class="flex items-center justify-between border-b border-edge px-3 py-2">
				<span class="text-xs font-semibold tracking-wider text-faint uppercase">Notifications</span>
				<button class="text-xs text-muted hover:text-fg" onclick={markAllRead}>
					Mark all read
				</button>
			</div>

			{#if items.length === 0}
				<p class="px-3 py-6 text-center text-xs text-faint">
					{failed ? 'Could not load notifications' : 'Nothing to report'}
				</p>
			{:else}
				<ul class="divide-y divide-edge/60">
					{#each items as item, i (`${item.kind}:${item.at}:${i}`)}
						{@const Icon = kindIcon(item.kind)}
						<li>
							{#if item.href}
								<a
									href={adminHref(item.href)}
									class="flex items-start gap-2.5 px-3 py-2.5 transition-colors hover:bg-raised"
									onclick={close}
								>
									<Icon class="mt-0.5 size-4 shrink-0 text-faint" />
									<span class="min-w-0 flex-1">
										<span class="block truncate text-sm text-fg">{item.title}</span>
										{#if item.sub}
											<span class="block truncate text-xs text-faint">{item.sub}</span>
										{/if}
									</span>
									<span class="mt-0.5 shrink-0 text-[10px] text-faint">{ago(item.at)}</span>
									{#if item.at > seen}
										<span class="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent"></span>
									{/if}
								</a>
							{:else}
								<div class="flex items-start gap-2.5 px-3 py-2.5">
									<Icon class="mt-0.5 size-4 shrink-0 text-faint" />
									<span class="min-w-0 flex-1">
										<span class="block truncate text-sm text-fg">{item.title}</span>
										{#if item.sub}
											<span class="block truncate text-xs text-faint">{item.sub}</span>
										{/if}
									</span>
									<span class="mt-0.5 shrink-0 text-[10px] text-faint">{ago(item.at)}</span>
									{#if item.at > seen}
										<span class="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent"></span>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}

			<div class="flex items-center justify-between border-t border-edge px-3 py-2">
				<span class="text-xs text-muted">Browser notifications</span>
				{#if pushSupported() && pushPermission() !== 'denied'}
					<button
						class="rounded-md border border-edge px-2 py-1 text-xs transition-colors {pushEnabled()
							? 'border-accent/40 text-accent'
							: 'text-muted hover:text-fg'}"
						disabled={pushBusy}
						onclick={togglePush}
						aria-pressed={pushEnabled()}
					>
						{pushEnabled() ? 'On' : 'Off'}
					</button>
				{:else}
					<span class="text-[11px] text-faint">{pushLabel()}</span>
				{/if}
			</div>
			{#if pushEnabled() && pushSupported()}
				<p class="px-3 pb-2 text-[10px] text-faint">
					Push alerts arrive even with this tab closed.
				</p>
			{/if}
		</div>
	{/if}
</div>
