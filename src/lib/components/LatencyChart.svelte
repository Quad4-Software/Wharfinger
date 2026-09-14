<script lang="ts">
	import type { LatencyPoint } from '$lib/shared/types';
	import { fmtMs } from '$lib/utils/format';

	interface ChartMarker {
		ts: number;
		title: string;
		kind: string;
	}

	const {
		points,
		height = 120,
		markers = []
	}: { points: LatencyPoint[]; height?: number; markers?: ChartMarker[] } = $props();
	const uid = $props.id();

	const W = 600;
	const H = 100;

	const values = $derived(points.filter((p) => p.avg !== null));
	const max = $derived(Math.max(10, ...values.map((p) => p.max ?? 0)));
	const avgOverall = $derived(
		values.length ? values.reduce((a, p) => a + (p.avg ?? 0), 0) / values.length : null
	);

	function xy(p: LatencyPoint): { x: number; y: number } {
		const x =
			((p.t - (points[0]?.t ?? p.t)) /
				Math.max(1, (points.at(-1)?.t ?? p.t) - (points[0]?.t ?? p.t))) *
			W;
		const y = H - ((p.avg ?? 0) / max) * (H - 8) - 4;
		return { x, y };
	}

	// Build an SVG path that breaks across empty buckets.
	const paths = $derived.by(() => {
		const segments: string[] = [];
		let cur = '';
		for (const p of points) {
			if (p.avg === null) {
				if (cur) segments.push(cur);
				cur = '';
				continue;
			}
			const { x, y } = xy(p);
			cur += `${cur ? ' L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
		}
		if (cur) segments.push(cur);
		return segments;
	});

	const area = $derived(
		paths.map((d) => {
			// Close each segment to the baseline for a filled area.
			const firstX = /M([\d.]+)/.exec(d)?.[1] ?? '0';
			const lastX = /L([\d.]+),[\d.]+$/.exec(d)?.[1] ?? '0';
			return `${d} L${lastX},${H} L${firstX},${H} Z`;
		})
	);

	const t0 = $derived(points[0]?.t ?? 0);
	const t1 = $derived(points.at(-1)?.t ?? 0);
	const markerXs = $derived(
		markers
			.filter((m) => m.ts >= t0 && m.ts <= t1 && t1 > t0)
			.map((m) => ({ ...m, x: ((m.ts - t0) / (t1 - t0)) * W }))
	);
</script>

<div class="space-y-2">
	<div class="flex items-baseline justify-between text-xs text-muted">
		<span>Response time, last 24h</span>
		<span class="font-mono">{avgOverall !== null ? `avg ${fmtMs(avgOverall)}` : 'no samples'}</span>
	</div>
	{#if values.length > 0}
		<svg
			viewBox="0 0 {W} {H}"
			preserveAspectRatio="none"
			class="w-full text-maint"
			style="height: {height}px"
			role="img"
			aria-label="Latency chart"
		>
			<defs>
				<linearGradient id="lat-fill-{uid}" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stop-color="currentColor" stop-opacity="0.35" />
					<stop offset="100%" stop-color="currentColor" stop-opacity="0.02" />
				</linearGradient>
			</defs>
			{#each area as d, i (i)}
				<path {d} fill="url(#lat-fill-{uid})" />
			{/each}
			{#each paths as d, i (i)}
				<path
					{d}
					fill="none"
					stroke="currentColor"
					stroke-width="1.5"
					vector-effect="non-scaling-stroke"
				/>
			{/each}
			{#each markerXs as m (m.ts)}
				<line
					x1={m.x}
					y1={0}
					x2={m.x}
					y2={H}
					class="stroke-fg/40"
					stroke-width="1"
					stroke-dasharray="3 2"
					vector-effect="non-scaling-stroke"
				>
					<title>{m.title}</title>
				</line>
			{/each}
		</svg>
	{:else}
		<div class="flex h-[100px] items-center justify-center text-xs text-faint">
			No latency data yet
		</div>
	{/if}
</div>
