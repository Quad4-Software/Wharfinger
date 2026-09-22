<script lang="ts">
	import { LogOut, Menu, X, Anchor, Search, ChevronRight } from '@lucide/svelte';
	import { onMount, type Snippet } from 'svelte';
	import { page } from '$app/state';
	import { adminHref, api } from '$lib/state/admin.svelte';
	import { chatUnread } from '$lib/state/chat.svelte';
	import type { User } from '$lib/server/admin/users';
	import Toasts from '$lib/components/Toasts.svelte';
	import CommandPalette from '$lib/components/admin/CommandPalette.svelte';
	import NotifyBell from '$lib/components/admin/NotifyBell.svelte';
	import { visibleSections, type NavItem } from '$lib/components/admin/nav';

	const { user, perms, children }: { user: User; perms: string[]; children: Snippet } = $props();

	let menuOpen = $state(false);
	let paletteOpen = $state(false);

	// The account page is reachable through the identity row below, not
	// as a sidebar nav item.
	const sections = $derived(
		visibleSections(perms)
			.map((s) => ({ label: s.label, items: s.items.filter((n) => n.sub !== '/account') }))
			.filter((s) => s.items.length > 0)
	);
	const current = $derived(page.url.pathname.slice(adminHref('').length) || '/');
	const currentLabel = $derived(
		sections.flatMap((s) => s.items).find((n) => active(n.sub))?.label ??
			(active('/account') ? 'Account' : 'Panel')
	);

	function active(sub: string): boolean {
		const here = page.url.pathname.slice(adminHref('').length) || '/';
		if (sub === '') return here === '/' || here === '';
		return here.startsWith(sub);
	}

	// Collapsed section labels, persisted locally. The section holding
	// the active route always stays expanded so context is visible.
	let collapsed = $state<string[]>(loadCollapsed());
	function loadCollapsed(): string[] {
		try {
			const raw = localStorage.getItem('wf-nav-collapsed');
			const parsed = raw ? (JSON.parse(raw) as unknown) : [];
			return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
		} catch {
			return [];
		}
	}
	function toggleSection(label: string): void {
		collapsed = collapsed.includes(label)
			? collapsed.filter((l) => l !== label)
			: [...collapsed, label];
		try {
			localStorage.setItem('wf-nav-collapsed', JSON.stringify(collapsed));
		} catch {
			// storage may be unavailable; collapse state just stays in memory
		}
	}
	function sectionCollapsed(label: string | null): boolean {
		return label !== null && collapsed.includes(label);
	}
	function sectionHasActive(items: NavItem[]): boolean {
		return items.some((n) => active(n.sub));
	}

	async function logout(): Promise<void> {
		await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
		location.href = adminHref('/login');
	}

	// SSR already stamps body.admin-flat; this covers client-side
	// navigation into or out of the panel.
	onMount(() => {
		document.body.classList.add('admin-flat');
		return () => {
			document.body.classList.remove('admin-flat');
		};
	});
</script>

<svelte:window
	onkeydown={(e: KeyboardEvent) => {
		if (e.key === 'Escape' && menuOpen) menuOpen = false;
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			paletteOpen = !paletteOpen;
		}
	}}
/>

<svelte:head>
	<title>{currentLabel} · Wharfinger</title>
</svelte:head>

<div class="flex min-h-screen">
	<!-- Mobile top bar -->
	<header
		class="fixed inset-x-0 top-0 z-40 flex items-center justify-between border-b border-edge bg-bg/90 px-4 py-3 backdrop-blur md:hidden"
	>
		<span class="flex items-center gap-2 text-sm font-semibold">
			<Anchor class="size-4 text-accent" /> Wharfinger
		</span>
		<div class="flex items-center gap-1">
			<button
				class="rounded-md p-1.5 text-muted hover:text-fg"
				onclick={() => (paletteOpen = true)}
				aria-label="Search"
			>
				<Search class="size-5" />
			</button>
			<NotifyBell userId={user.id} />
			<button
				class="rounded-md p-1.5 text-muted hover:text-fg"
				onclick={() => (menuOpen = !menuOpen)}
				aria-label="Toggle navigation"
			>
				{#if menuOpen}<X class="size-5" />{:else}<Menu class="size-5" />{/if}
			</button>
		</div>
	</header>

	<!-- Sidebar -->
	<nav
		class="fixed inset-y-0 left-0 z-50 flex w-56 flex-col border-r border-edge bg-raised transition-transform md:translate-x-0 {menuOpen
			? 'translate-x-0'
			: '-translate-x-full'}"
		aria-label="Admin"
	>
		<div class="flex items-center gap-2 px-4 py-4">
			<Anchor class="size-4 text-accent" />
			<span class="text-sm font-semibold tracking-tight">Wharfinger</span>
		</div>
		<div class="mx-2 mb-2 flex items-center gap-1">
			<button
				class="flex flex-1 items-center gap-2 rounded-lg border border-edge bg-bg/50 px-3 py-1.5 text-xs text-faint transition-colors hover:border-accent/40 hover:text-muted"
				onclick={() => (paletteOpen = true)}
			>
				<Search class="size-3.5" />
				<span class="flex-1 text-left">Search</span>
				<kbd
					class="rounded border border-edge bg-panel px-1 py-0.5 font-sans text-[10px] leading-none text-faint"
					>Ctrl K</kbd
				>
			</button>
			<NotifyBell userId={user.id} />
		</div>
		<div class="thin-scroll flex-1 overflow-y-auto px-2 pb-4">
			{#each sections as section, si (section.label ?? 'top')}
				{#if section.label !== null}
					<button
						class="mt-3 flex w-full items-center gap-1.5 rounded-md px-3 py-1 text-[10px] font-semibold tracking-wider text-faint uppercase transition-colors hover:text-muted first:mt-1"
						onclick={() => {
							if (section.label !== null) toggleSection(section.label);
						}}
						aria-expanded={!sectionCollapsed(section.label)}
					>
						<ChevronRight
							class="size-3 shrink-0 transition-transform {sectionCollapsed(section.label)
								? ''
								: 'rotate-90'}"
						/>
						{section.label}
						{#if sectionCollapsed(section.label) && sectionHasActive(section.items)}
							<span class="ml-auto size-1.5 rounded-full bg-accent"></span>
						{/if}
					</button>
				{/if}
				{#if !sectionCollapsed(section.label)}
					<div class="space-y-0.5" class:mt-0.5={section.label !== null}>
						{#each section.items as item (item.sub)}
							{@const Icon = item.icon}
							<a
								href={adminHref(item.sub || '/')}
								class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors {active(
									item.sub
								)
									? 'bg-panel font-medium text-fg'
									: 'text-muted hover:bg-panel/60 hover:text-fg'}"
								onclick={() => (menuOpen = false)}
							>
								<Icon class="size-4 shrink-0" />
								{item.label}
								{#if item.sub === '/chat' && chatUnread() > 0}
									<span
										class="ml-auto flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-bg"
										aria-label="{chatUnread()} unread messages"
									>
										{chatUnread() > 99 ? '99+' : chatUnread()}
									</span>
								{/if}
							</a>
						{/each}
					</div>
				{/if}
				{#if si === 0}<div class="mt-1"></div>{/if}
			{/each}
		</div>
		<div class="border-t border-edge px-3 py-3">
			<div class="flex items-center gap-1">
				<a
					href={adminHref('/account')}
					class="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 py-1.5 transition-colors {active(
						'/account'
					)
						? 'bg-panel'
						: 'hover:bg-panel/60'}"
					title="Account settings"
				>
					{#if user.hasAvatar}
						<img
							class="size-8 shrink-0 rounded-full border border-edge object-cover"
							src={adminHref(`/api/avatar/${user.id}`)}
							alt=""
							width="32"
							height="32"
						/>
					{:else}
						<span
							class="flex size-8 shrink-0 items-center justify-center rounded-full border border-edge bg-raised text-sm font-medium text-muted"
						>
							{(user.displayName || user.username).slice(0, 1).toUpperCase()}
						</span>
					{/if}
					<div class="min-w-0">
						<p class="truncate text-sm font-medium text-fg">
							{user.displayName || user.username}
						</p>
						<p class="text-xs capitalize text-faint">{user.role}</p>
					</div>
				</a>
				<button
					class="btn btn-ghost shrink-0 !p-2"
					onclick={logout}
					title="Sign out"
					aria-label="Sign out"
				>
					<LogOut class="size-4" />
				</button>
			</div>
		</div>
	</nav>
	{#if menuOpen}
		<button
			class="fixed inset-0 z-40 bg-black/50 md:hidden"
			onclick={() => (menuOpen = false)}
			aria-label="Close navigation"
		></button>
	{/if}

	<main class="min-w-0 flex-1 px-4 pb-16 pt-20 md:ml-56 md:px-8 md:pt-8">
		{@render children()}
	</main>
</div>

<CommandPalette bind:open={paletteOpen} {perms} />
<Toasts />
<!-- current route hint for a11y tests -->
<span class="sr-only">{current}</span>
