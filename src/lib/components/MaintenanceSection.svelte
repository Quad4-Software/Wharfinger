<script lang="ts">
	import { CalendarClock, Wrench } from '@lucide/svelte';
	import type { MaintenanceWindow } from '$lib/shared/types';
	import { WEEKDAY_KEYS } from '$lib/i18n';
	import { fmtDateTime, t } from '$lib/i18n/locale.svelte';

	const { windows, active }: { windows: MaintenanceWindow[]; active: boolean } = $props();

	// Unknown weekday tokens render raw, matching the pre-i18n fallback.
	function weekdayLabel(token: string): string {
		const key = WEEKDAY_KEYS[token];
		return key ? t(key) : token;
	}
</script>

{#if windows.length > 0}
	<section
		class="space-y-3"
		aria-label={active ? t('maint.active_aria') : t('maint.scheduled_aria')}
	>
		<h2 class="flex items-center gap-2 text-sm font-medium text-muted">
			{#if active}
				<Wrench class="size-4 text-maint" /> {t('maint.ongoing')}
			{:else}
				<CalendarClock class="size-4 text-maint" /> {t('maint.scheduled')}
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
								>· {t('maint.repeats', { day: weekdayLabel(w.weekly) })}</span
							>
						{/if}
					</div>
				</div>
				{#if w.description}
					<p class="mt-1 text-sm text-muted">{w.description}</p>
				{/if}
				{#if !w.services.includes('*')}
					<p class="mt-1 text-xs text-muted">
						{t('maint.affects', { services: w.services.join(', ') })}
					</p>
				{/if}
			</div>
		{/each}
	</section>
{/if}
