<script lang="ts">
	import { adminHref } from '$lib/state/admin.svelte';
	import type { ChatPresenceState } from '$lib/shared/chat';

	// Circular avatar with a presence ring: accent/green online, amber
	// away, faint gray offline, plain edge when no state applies.
	const {
		userId,
		name,
		hasAvatar = false,
		presence = null,
		size = 'size-8'
	}: {
		userId: number;
		name: string;
		hasAvatar?: boolean;
		presence?: ChatPresenceState | null;
		size?: string;
	} = $props();

	const ring = $derived(
		presence === 'online'
			? 'box-shadow: 0 0 0 2px var(--color-up)'
			: presence === 'away'
				? 'box-shadow: 0 0 0 2px var(--color-degraded)'
				: presence === 'offline'
					? 'box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-faint) 45%, transparent)'
					: ''
	);

	const letter = $derived(
		{
			'size-5': 'text-[8px]',
			'size-6': 'text-[10px]',
			'size-7': 'text-xs',
			'size-8': 'text-sm',
			'size-9': 'text-sm',
			'size-10': 'text-base'
		}[size] ?? 'text-xs'
	);
</script>

<span
	class="inline-flex shrink-0 items-center justify-center rounded-full {size}"
	style={ring || undefined}
	title={presence ?? undefined}
>
	{#if hasAvatar}
		<img
			class="rounded-full border border-edge object-cover {size}"
			src={adminHref(`/api/avatar/${userId}`)}
			alt=""
			loading="lazy"
		/>
	{:else}
		<span
			class="flex items-center justify-center rounded-full border border-edge bg-raised font-medium text-muted {size} {letter}"
		>
			{name.slice(0, 1).toUpperCase()}
		</span>
	{/if}
</span>
