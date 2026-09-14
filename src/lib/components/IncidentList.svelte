<script lang="ts">
	import { TriangleAlert, Flame, CircleCheck } from '@lucide/svelte';
	import type { Incident } from '$lib/shared/types';
	import { durationBetween, fmtDateTime } from '$lib/utils/format';

	const { incidents, title }: { incidents: Incident[]; title: string } = $props();

	const sevIcon = { minor: TriangleAlert, major: Flame, maintenance: TriangleAlert } as const;
	const sevClass = {
		minor: 'text-degraded-fg bg-degraded/10 ring-degraded/30',
		major: 'text-down-fg bg-down/10 ring-down/30',
		maintenance: 'text-maint-fg bg-maint/10 ring-maint/30'
	} as const;
</script>

<section class="space-y-3" aria-label={title}>
	<h2 class="text-xs font-semibold tracking-widest text-muted uppercase">{title}</h2>
	{#if incidents.length === 0}
		<div class="card flex items-center gap-3 p-4 text-sm text-muted">
			<CircleCheck class="size-4 text-up" />
			Nothing to report.
		</div>
	{:else}
		<div class="space-y-3">
			{#each incidents as inc (inc.id)}
				{@const Icon = sevIcon[inc.severity]}
				<article class="card p-4">
					<div class="flex flex-wrap items-start justify-between gap-2">
						<div class="flex items-start gap-3">
							<span
								class="mt-0.5 inline-flex size-7 items-center justify-center rounded-lg ring-1 ring-inset {sevClass[
									inc.severity
								]}"
							>
								<Icon class="size-4" />
							</span>
							<div>
								<h3 class="text-sm font-medium text-fg">{inc.title}</h3>
								<p class="mt-0.5 text-xs text-muted">
									{fmtDateTime(inc.startedAt)} ·
									{inc.resolvedAt
										? `resolved after ${durationBetween(inc.startedAt, inc.resolvedAt)}`
										: 'ongoing'} · affects {inc.services.join(', ')}
								</p>
							</div>
						</div>
						<span
							class="rounded-full px-2 py-0.5 text-[11px] font-medium {inc.resolvedAt
								? 'bg-up/10 text-up-fg'
								: 'bg-down/10 text-down-fg'}"
						>
							{inc.resolvedAt ? 'Resolved' : 'Ongoing'}
						</span>
					</div>
					{#if inc.updates.length > 0}
						<ul class="mt-3 space-y-1.5 border-l border-edge pl-4">
							{#each inc.updates as u (u.at)}
								<li class="text-xs text-muted">
									<span class="text-faint">{fmtDateTime(u.at)}</span> · {u.message}
								</li>
							{/each}
						</ul>
					{/if}
				</article>
			{/each}
		</div>
	{/if}
</section>
