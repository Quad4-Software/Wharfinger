<script lang="ts">
	import { CircleCheck, TriangleAlert, CircleX, Wrench, CircleQuestionMark } from '@lucide/svelte';
	import { OVERALL_LABEL, type ServiceStatus } from '$lib/shared/status';
	import { STATUS_HEX } from '$lib/utils/status-style';
	import { relativeTime } from '$lib/utils/format';

	const {
		overall,
		generatedAt,
		now
	}: { overall: ServiceStatus; generatedAt: string; now: number } = $props();

	const Icon = $derived(
		overall === 'operational'
			? CircleCheck
			: overall === 'major_outage' || overall === 'partial_outage'
				? CircleX
				: overall === 'maintenance'
					? Wrench
					: overall === 'unknown'
						? CircleQuestionMark
						: TriangleAlert
	);
	const color = $derived(STATUS_HEX[overall]);
</script>

<section
	class="card relative overflow-hidden p-6 sm:p-8"
	aria-live="polite"
	aria-label="Overall status"
>
	<div
		class="pointer-events-none absolute inset-0 opacity-60"
		style="background: radial-gradient(600px 160px at 20% 0%, color-mix(in srgb, {color} 14%, transparent), transparent 70%)"
	></div>
	<div class="relative flex flex-wrap items-center justify-between gap-4">
		<div class="flex items-center gap-4">
			<div
				class="flex size-12 items-center justify-center rounded-xl"
				style="background: color-mix(in srgb, {color} 15%, transparent); color: {color}"
			>
				<Icon class="size-6" strokeWidth={2.2} />
			</div>
			<div>
				<h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">{OVERALL_LABEL[overall]}</h1>
				<p class="mt-0.5 text-sm text-muted">
					Last updated {relativeTime(generatedAt, now)}
				</p>
			</div>
		</div>
	</div>
</section>
