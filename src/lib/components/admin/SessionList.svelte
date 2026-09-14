<script lang="ts">
	import { Bot, Globe, LogOut, Monitor, Smartphone, Tablet, Terminal } from '@lucide/svelte';
	import { relativeTime } from '$lib/utils/format';
	import { parseUA } from '$lib/shared/ua';

	interface Session {
		hash: string;
		createdAt: number;
		expiresAt: number;
		lastSeenAt: number;
		ip: string | null;
		userAgent: string | null;
		current: boolean;
	}

	const {
		sessions,
		onrevoke
	}: {
		sessions: Session[];
		onrevoke: (s: Session) => void;
	} = $props();

	function sessionIcon(s: Session) {
		const ua = parseUA(s.userAgent);
		if (ua.device === 'mobile') return Smartphone;
		if (ua.device === 'tablet') return Tablet;
		if (ua.device === 'bot') return Bot;
		if (ua.device === 'cli') return Terminal;
		if (ua.device === 'unknown' || ua.browser === 'Unknown browser') return Monitor;
		return Globe;
	}
</script>

{#if sessions.length === 0}
	<p class="text-sm text-faint">No active sessions.</p>
{:else}
	<ul class="divide-y divide-edge">
		{#each sessions as s (s.hash)}
			{@const ua = parseUA(s.userAgent)}
			{@const Icon = sessionIcon(s)}
			<li class="flex items-center gap-3 py-2.5 text-sm">
				<Icon class="size-5 shrink-0 text-faint" />
				<div class="min-w-0 flex-1">
					<p class="truncate text-fg">
						{ua.browser}{ua.os ? ` · ${ua.os}` : ''}
						{#if s.current}<span class="chip chip-on ml-1">this device</span>{/if}
					</p>
					<p class="truncate text-xs text-faint" title={s.userAgent ?? ''}>
						{s.ip ?? 'unknown ip'} · active {relativeTime(s.lastSeenAt)} · expires
						{relativeTime(s.expiresAt)}
					</p>
				</div>
				<button
					class="btn btn-ghost btn-sm shrink-0"
					title="Sign out"
					onclick={() => {
						onrevoke(s);
					}}
				>
					<LogOut class="size-3.5" />
				</button>
			</li>
		{/each}
	</ul>
{/if}
