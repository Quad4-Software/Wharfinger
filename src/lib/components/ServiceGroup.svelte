<script lang="ts">
	import type { GroupSnapshot } from '$lib/shared/types';
	import ServiceCard from './ServiceCard.svelte';

	const { group, now }: { group: GroupSnapshot; now: number } = $props();
</script>

<section aria-label={group.name} class="space-y-3">
	<h2 class="text-xs font-semibold tracking-widest text-muted uppercase">{group.name}</h2>
	<div class="space-y-3">
		{#each group.services as service (service.id)}
			<ServiceCard {service} {now} />
		{/each}
	</div>
</section>
