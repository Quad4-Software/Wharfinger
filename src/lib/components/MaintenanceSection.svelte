<script lang="ts">
	import { CalendarClock, Wrench } from '@lucide/svelte';
	import type { MaintenanceWindow } from '$lib/shared/types';
	import { fmtDateTime } from '$lib/utils/format';

	const WEEKDAY_LABEL: Record<string, string> = {
		sun: 'Sunday',
		mon: 'Monday',
		tue: 'Tuesday',
		wed: 'Wednesday',
		thu: 'Thursday',
		fri: 'Friday',
		sat: 'Saturday'
	};

	const { windows, active }: { windows: MaintenanceWindow[]; active: boolean } = $props();
</script>

{#if windows.length > 0}
	<section class="space-y-3" aria-label={active ? 'Active maintenance' : 'Scheduled maintenance'}>
		<h2 class="flex items-center gap-2 text-sm font-medium text-muted">
			{#if active}
				<Wrench class="size-4 text-maint" /> Ongoing Maintenance
			{:else}
				<CalendarClock class="size-4 text-maint" /> Scheduled Maintenance
			{/if}
		</h2>
		{#each windows as w (w.id)}
			<div class="card border-maint/20 p-4">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<div class="font-medium text-maint-fg">{w.title}</div>
					<div class="text-xs text-muted">
						{fmtDateTime(w.startsAt)} - {fmtDateTime(w.endsAt)}
						{#if w.weekly}
							<span class="ml-1 text-faint"
								>· repeats every {WEEKDAY_LABEL[w.weekly] ?? w.weekly}</span
							>
						{/if}
					</div>
				</div>
				{#if w.description}
					<p class="mt-1 text-sm text-muted">{w.description}</p>
				{/if}
				{#if !w.services.includes('*')}
					<p class="mt-1 text-xs text-muted">Affects: {w.services.join(', ')}</p>
				{/if}
			</div>
		{/each}
	</section>
{/if}
