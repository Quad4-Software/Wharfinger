<script lang="ts">
	import type { PageProps } from './$types';
	import StatusPage from '$lib/components/StatusPage.svelte';

	const { data }: PageProps = $props();
</script>

<StatusPage snapshot={data.snapshot} page={null} />
