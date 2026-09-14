<script lang="ts">
	import { TriangleAlert, Flame, Wrench, CircleCheck, ChevronDown, Rss } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import type { Incident } from '$lib/shared/types';
	import { durationBetween, fmtDateTime } from '$lib/utils/format';

	const { incidents, title = 'Past incidents' }: { incidents: Incident[]; title?: string } =
		$props();

	const sevIcon = { minor: TriangleAlert, major: Flame, maintenance: Wrench } as const;
	const sevClass = {
		minor: 'text-degraded-fg bg-degraded/10 ring-degraded/30',
		major: 'text-down-fg bg-down/10 ring-down/30',
		maintenance: 'text-maint-fg bg-maint/10 ring-maint/30'
	} as const;
</script>

<section class="card overflow-hidden" aria-label={title}>
	<header class="flex items-center justify-between gap-3 border-b border-edge px-4 py-3">
		<h2 class="text-xs font-semibold tracking-widest text-muted uppercase">{title}</h2>
		{#if incidents.length > 0}
			<span class="chip">{incidents.length}</span>
		{/if}
	</header>

	{#if incidents.length === 0}
		<div class="flex items-center gap-3 px-4 py-4 text-sm text-muted">
			<CircleCheck class="size-4 shrink-0 text-up" />
			No incidents on record.
		</div>
	{:else}
		<ul
			class="thin-scroll divide-y divide-edge rail:max-h-[calc(100dvh-10rem)] rail:overflow-y-auto"
		>
			{#each incidents as inc (inc.id)}
				{@const Icon = sevIcon[inc.severity]}
				<li>
					{#if inc.updates.length > 0}
						<details class="group">
							<summary
								class="flex cursor-pointer list-none items-start gap-3 px-4 py-3 transition-colors hover:bg-overlay/2 [&::-webkit-details-marker]:hidden"
							>
								<span
									class="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md ring-1 ring-inset {sevClass[
										inc.severity
									]}"
								>
									<Icon class="size-3.5" />
								</span>
								<span class="min-w-0 flex-1">
									<span class="block text-sm font-medium text-fg">{inc.title}</span>
									<span class="mt-0.5 block text-xs text-muted">
										{fmtDateTime(inc.startedAt)} ·
										{inc.resolvedAt
											? `resolved after ${durationBetween(inc.startedAt, inc.resolvedAt)}`
											: 'ongoing'}
									</span>
									<span class="mt-0.5 block truncate text-xs text-faint">
										affects {inc.services.join(', ')}
									</span>
								</span>
								<ChevronDown
									class="mt-1 size-3.5 shrink-0 text-faint transition-transform duration-200 group-open:rotate-180"
								/>
							</summary>
							<ul class="space-y-1.5 border-t border-edge/60 bg-overlay/2 px-4 py-3">
								{#each inc.updates as u (u.at)}
									<li class="text-xs text-muted">
										<span class="text-faint">{fmtDateTime(u.at)}</span> · {u.message}
									</li>
								{/each}
							</ul>
						</details>
					{:else}
						<div class="flex items-start gap-3 px-4 py-3">
							<span
								class="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md ring-1 ring-inset {sevClass[
									inc.severity
								]}"
							>
								<Icon class="size-3.5" />
							</span>
							<div class="min-w-0 flex-1">
								<h3 class="text-sm font-medium text-fg">{inc.title}</h3>
								<p class="mt-0.5 text-xs text-muted">
									{fmtDateTime(inc.startedAt)} ·
									{inc.resolvedAt
										? `resolved after ${durationBetween(inc.startedAt, inc.resolvedAt)}`
										: 'ongoing'}
								</p>
								<p class="mt-0.5 truncate text-xs text-faint">
									affects {inc.services.join(', ')}
								</p>
							</div>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
		<footer class="border-t border-edge px-4 py-2.5">
			<a
				href={resolve('/feed.xml')}
				class="inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-fg"
			>
				<Rss class="size-3.5" /> Subscribe to incident updates
			</a>
		</footer>
	{/if}
</section>
