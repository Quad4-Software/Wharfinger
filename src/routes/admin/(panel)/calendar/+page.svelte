<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { CalendarDays } from '@lucide/svelte';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import Calendar, { type CalEvent } from '$lib/components/admin/Calendar.svelte';
	import { api, ApiError, adminHref } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import { weeklyOccurrences } from '$lib/shared/maintenance';
	import type { MaintDraft } from '$lib/shared/drafts';
	import type { Incident } from '$lib/shared/types';

	interface SectionView {
		value: MaintDraft[];
	}
	interface Overview {
		incidents: { active: Incident[]; recent: Incident[] };
	}

	let loading = $state(true);
	let events = $state<CalEvent[]>([]);

	async function load(): Promise<void> {
		try {
			const [sec, ov] = await Promise.all([
				api<SectionView>('/sections/maintenance'),
				api<Overview>('/overview')
			]);
			const out: CalEvent[] = [];
			const now = Date.now();
			const from = now - 90 * 86_400_000;
			const to = now + 365 * 86_400_000;
			for (const w of sec.value) {
				if (w.weekly && w.at && w.duration_minutes) {
					for (const o of weeklyOccurrences(w.weekly, w.at, w.duration_minutes, from, to)) {
						out.push({ title: w.title, startMs: o.start, endMs: o.end, tone: 'maint' });
					}
				} else if (w.start && w.end) {
					out.push({
						title: w.title,
						startMs: Date.parse(w.start),
						endMs: Date.parse(w.end),
						tone: 'maint'
					});
				}
			}
			const seen = new SvelteSet<string>();
			for (const i of [...ov.incidents.active, ...ov.incidents.recent]) {
				if (seen.has(i.id)) continue;
				seen.add(i.id);
				out.push({
					title: i.title,
					startMs: Date.parse(i.startedAt),
					endMs: i.resolvedAt ? Date.parse(i.resolvedAt) : now,
					tone: 'incident',
					href: adminHref('/incidents')
				});
			}
			events = out;
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'load failed');
		} finally {
			loading = false;
		}
	}

	onMount(load);
</script>

<PageHeader
	title="Calendar"
	description="Maintenance windows and incidents on one timeline. Times shown in your local timezone."
/>

{#if loading}
	<div class="card h-96 animate-pulse"></div>
{:else}
	<div class="mb-3 flex flex-wrap gap-3 text-xs text-faint">
		<span class="flex items-center gap-1.5"
			><span class="size-2.5 rounded bg-maint/60"></span> Maintenance</span
		>
		<span class="flex items-center gap-1.5"
			><span class="size-2.5 rounded bg-down/60"></span> Incidents</span
		>
		<span class="flex items-center gap-1.5">
			<CalendarDays class="size-3.5" /> Recurring windows repeat weekly (UTC schedule, local display)
		</span>
	</div>
	<Calendar {events} />
{/if}
