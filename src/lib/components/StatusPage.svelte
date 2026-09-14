<script lang="ts">
	import { untrack } from 'svelte';
	import { useInterval } from 'runed';
	import type { PageMeta, StatusSnapshot } from '$lib/shared/types';
	import { filterSnapshot } from '$lib/shared/pages';
	import { StatusStream } from '$lib/state/status-stream.svelte';
	import Announcement from '$lib/components/Announcement.svelte';
	import IncidentList from '$lib/components/IncidentList.svelte';
	import IncidentRail from '$lib/components/IncidentRail.svelte';
	import MaintenanceSection from '$lib/components/MaintenanceSection.svelte';
	import OverallBanner from '$lib/components/OverallBanner.svelte';
	import ServiceGroup from '$lib/components/ServiceGroup.svelte';
	import SiteFooter from '$lib/components/SiteFooter.svelte';
	import SiteHeader from '$lib/components/SiteHeader.svelte';

	const { snapshot: initial, page: pageMeta }: { snapshot: StatusSnapshot; page: PageMeta | null } =
		$props();

	// The stream always pushes the full snapshot; per-page views re-filter
	// on every update so all pages share one feed.
	let snapshot = $state<StatusSnapshot>(untrack(() => initial));
	let now = $state(Date.now());
	let activeGroups = $state<string[]>([]);

	const stream = new StatusStream(
		(s) => {
			snapshot = pageMeta ? filterSnapshot(s, pageMeta) : s;
		},
		untrack(() => snapshot.refreshSeconds)
	);
	$effect(() => {
		stream.start();
		return () => {
			stream.stop();
		};
	});

	// Tick every second so relative timestamps stay fresh.
	useInterval(() => 1000, { callback: () => (now = Date.now()) });

	const site = $derived(snapshot.site);
	const filterGroups = $derived(snapshot.serviceGroups);
	const visibleGroups = $derived(
		activeGroups.length === 0
			? snapshot.groups
			: snapshot.groups
					.map((g) => ({
						...g,
						services: g.services.filter((s) => s.groupIds.some((id) => activeGroups.includes(id)))
					}))
					.filter((g) => g.services.length > 0)
	);

	function toggleGroup(id: string): void {
		activeGroups = activeGroups.includes(id)
			? activeGroups.filter((g) => g !== id)
			: [...activeGroups, id];
	}
</script>

<a href="#status-content" class="skip-link">Skip to status</a>
<div class="mx-auto max-w-3xl px-4 sm:px-6 rail:max-w-6xl" style="--color-accent: {site.accent}">
	<SiteHeader {site} pages={snapshot.pages} currentSlug={pageMeta?.slug ?? null} />

	{#if pageMeta?.description}
		<p class="-mt-2 pb-2 text-sm text-muted">{pageMeta.description}</p>
	{/if}

	<div class="rail:grid rail:grid-cols-[minmax(0,1fr)_18rem] rail:items-start rail:gap-10">
		<main id="status-content" class="min-w-0 scroll-mt-6 space-y-8">
			{#if site.announcement}
				<Announcement announcement={site.announcement} />
			{/if}

			<OverallBanner overall={snapshot.overall} generatedAt={snapshot.generatedAt} {now} />

			{#if snapshot.incidents.active.length > 0}
				<IncidentList incidents={snapshot.incidents.active} title="Ongoing Incidents" />
			{/if}

			<MaintenanceSection windows={snapshot.maintenance.active} active />
			<MaintenanceSection windows={snapshot.maintenance.upcoming} active={false} />

			{#if filterGroups.length > 0}
				<div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter services">
					{#each filterGroups as g (g.id)}
						<button
							type="button"
							class="chip flex cursor-pointer items-center gap-1.5 py-1 {activeGroups.includes(g.id)
								? 'chip-on'
								: ''}"
							aria-pressed={activeGroups.includes(g.id)}
							onclick={() => {
								toggleGroup(g.id);
							}}
						>
							{#if g.color}
								<span
									class="size-2 rounded-full"
									style="background-color: {g.color}"
									aria-hidden="true"
								></span>
							{/if}
							{g.name}
						</button>
					{/each}
					{#if activeGroups.length > 0}
						<button
							type="button"
							class="chip cursor-pointer py-1"
							onclick={() => {
								activeGroups = [];
							}}
						>
							Clear
						</button>
					{/if}
				</div>
			{/if}

			{#each visibleGroups as group (group.name)}
				<ServiceGroup {group} {now} />
			{/each}
		</main>

		<aside class="mt-8 rail:sticky rail:top-6 rail:mt-0" aria-label="Incident history">
			<IncidentRail incidents={snapshot.incidents.recent} />
		</aside>
	</div>

	<SiteFooter siteName={site.name} refreshSeconds={snapshot.refreshSeconds} />
</div>
