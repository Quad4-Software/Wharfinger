<script lang="ts">
	import {
		LayoutDashboard,
		Activity,
		Server,
		Wrench,
		Siren,
		Files,
		CalendarDays,
		Palette,
		Bell,
		Bug,
		Users,
		ScrollText,
		Settings,
		CircleUser,
		LogOut,
		Menu,
		MessageSquare,
		Rocket,
		ShieldCheck,
		Radar,
		Boxes,
		UsersRound,
		KeyRound,
		X,
		ExternalLink
	} from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import { adminHref, api } from '$lib/state/admin.svelte';
	import { chatUnread } from '$lib/state/chat.svelte';
	import type { User } from '$lib/server/admin/users';
	import Toasts from '$lib/components/Toasts.svelte';

	const { user, perms, children }: { user: User; perms: string[]; children: Snippet } = $props();

	let menuOpen = $state(false);

	const NAV: { sub: string; label: string; icon: typeof Activity; perm?: string }[] = [
		{ sub: '', label: 'Dashboard', icon: LayoutDashboard },
		{ sub: '/chat', label: 'Chat', icon: MessageSquare },
		{ sub: '/services', label: 'Services', icon: Activity, perm: 'status.manage' },
		{ sub: '/agents', label: 'Systems', icon: Server, perm: 'agents.manage' },
		{ sub: '/deploy', label: 'Deployments', icon: Rocket, perm: 'deploy.view' },
		{ sub: '/security', label: 'Security', icon: ShieldCheck, perm: 'scan.view' },
		{ sub: '/anomalies', label: 'Anomalies', icon: Radar, perm: 'anomaly.view' },
		{ sub: '/groups', label: 'Groups', icon: Boxes, perm: 'groups.manage' },
		{ sub: '/teams', label: 'Teams', icon: UsersRound, perm: 'teams.manage' },
		{ sub: '/secrets', label: 'Secrets', icon: KeyRound, perm: 'secrets.manage' },
		{ sub: '/maintenance', label: 'Maintenance', icon: Wrench, perm: 'status.manage' },
		{ sub: '/calendar', label: 'Calendar', icon: CalendarDays, perm: 'status.manage' },
		{ sub: '/incidents', label: 'Incidents', icon: Siren, perm: 'status.manage' },
		{ sub: '/pages', label: 'Pages', icon: Files, perm: 'status.manage' },
		{ sub: '/customize', label: 'Customize', icon: Palette, perm: 'status.manage' },
		{ sub: '/notifications', label: 'Notifications', icon: Bell, perm: 'status.manage' },
		{ sub: '/telemetry', label: 'Error tracking', icon: Bug, perm: 'telemetry.view' },
		{ sub: '/users', label: 'Users', icon: Users, perm: 'users.manage' },
		{ sub: '/audit', label: 'Audit log', icon: ScrollText, perm: 'audit.view' },
		{ sub: '/settings', label: 'Settings', icon: Settings, perm: 'admin.settings' },
		{ sub: '/account', label: 'Account', icon: CircleUser }
	];

	const items = $derived(NAV.filter((n) => !n.perm || perms.includes(n.perm)));
	const current = $derived(page.url.pathname.slice(adminHref('').length) || '/');

	function active(sub: string): boolean {
		const here = page.url.pathname.slice(adminHref('').length) || '/';
		if (sub === '') return here === '/' || here === '';
		return here.startsWith(sub);
	}

	async function logout(): Promise<void> {
		await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
		location.href = adminHref('/login');
	}
</script>

<svelte:window
	onkeydown={(e: KeyboardEvent) => {
		if (e.key === 'Escape' && menuOpen) menuOpen = false;
	}}
/>

<div class="flex min-h-screen">
	<!-- Mobile top bar -->
	<header
		class="fixed inset-x-0 top-0 z-40 flex items-center justify-between border-b border-edge bg-bg/90 px-4 py-3 backdrop-blur md:hidden"
	>
		<span class="text-sm font-semibold">Status Panel</span>
		<button
			class="rounded-md p-1.5 text-muted hover:text-fg"
			onclick={() => (menuOpen = !menuOpen)}
			aria-label="Toggle navigation"
		>
			{#if menuOpen}<X class="size-5" />{:else}<Menu class="size-5" />{/if}
		</button>
	</header>

	<!-- Sidebar -->
	<nav
		class="fixed inset-y-0 left-0 z-50 flex w-56 flex-col border-r border-edge bg-raised transition-transform md:translate-x-0 {menuOpen
			? 'translate-x-0'
			: '-translate-x-full'}"
		aria-label="Admin"
	>
		<div class="flex items-center justify-between px-4 py-4">
			<span class="text-sm font-semibold tracking-tight">Status Panel</span>
			<a href="/" class="text-faint transition-colors hover:text-fg" title="View status page">
				<ExternalLink class="size-4" />
			</a>
		</div>
		<div class="flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
			{#each items as item (item.sub)}
				{@const Icon = item.icon}
				<a
					href={adminHref(item.sub || '/')}
					class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors {active(
						item.sub
					)
						? 'bg-panel text-fg font-medium'
						: 'text-muted hover:bg-panel/60 hover:text-fg'}"
					onclick={() => (menuOpen = false)}
				>
					<Icon class="size-4 shrink-0" />
					{item.label}
					{#if item.sub === '/chat' && chatUnread() > 0}
						<span
							class="ml-auto size-2 shrink-0 rounded-full bg-accent"
							aria-label="Unread messages"
						></span>
					{/if}
				</a>
			{/each}
		</div>
		<div class="border-t border-edge px-3 py-3">
			<div class="mb-2 flex items-center gap-2.5 px-1">
				{#if user.hasAvatar}
					<img
						class="size-8 shrink-0 rounded-full border border-edge object-cover"
						src={adminHref(`/api/avatar/${user.id}`)}
						alt=""
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
			</div>
			<button class="btn btn-ghost w-full justify-start" onclick={logout}>
				<LogOut class="size-4" /> Sign out
			</button>
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

<Toasts />
<!-- current route hint for a11y tests -->
<span class="sr-only">{current}</span>
