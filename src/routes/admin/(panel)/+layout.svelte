<script lang="ts">
	import type { Snippet } from 'svelte';
	import AdminShell from '$lib/components/admin/AdminShell.svelte';
	import type { User } from '$lib/server/admin/users';

	const { data, children }: { data: { user: User; perms: string[] }; children: Snippet } = $props();
</script>

<svelte:head>
	<title>Status panel</title>
</svelte:head>

<AdminShell user={data.user} perms={data.perms}>
	{@render children()}
</AdminShell>
