<script lang="ts">
	import { page } from '$app/state';
	import { ArrowRight } from '@lucide/svelte';
	import { adminHref } from '$lib/state/admin.svelte';

	// Inline empty-state for option lists: a message plus an optional
	// link to the page where the missing resource is created. The link
	// is hidden when the user lacks the required permission.
	const {
		message,
		href,
		linkLabel,
		perm
	}: { message: string; href?: string; linkLabel?: string; perm?: string } = $props();

	const canFollow = $derived(
		!perm || ((page.data.perms as string[] | undefined) ?? []).includes(perm)
	);
</script>

<p class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-faint">
	<span>{message}</span>
	{#if href && linkLabel && canFollow}
		<a class="inline-flex items-center gap-0.5 text-accent hover:underline" href={adminHref(href)}>
			{linkLabel}<ArrowRight class="size-3" />
		</a>
	{/if}
</p>
