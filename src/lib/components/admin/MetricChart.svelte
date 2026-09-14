<script lang="ts">
	// Dependency-free SVG time series chart. Multi-series, hover
	// crosshair, fixed or auto y-domain. Used by the system detail page
	// for cpu/mem/disk/net/load graphs.

	export interface Series {
		label: string;
		color: string;
		points: { ts: number; v: number | null }[];
	}

	const {
		series,
		unit = '',
		max,
		height = 180,
		format
	}: {
		series: Series[];
		unit?: string;
		max?: number;
		height?: number;
		format?: (v: number) => string;
	} = $props();

	const W = 720;
	const H = 180;
	const PAD_L = 44;
	const PAD_R = 8;
	const PAD_T = 10;
	const PAD_B = 20;

	let hover = $state<number | null>(null);

	// Single-pass bounds: Math.min(...spread) overflows the stack on large
	// series and flatMap builds a throwaway array.
	const bounds = $derived.by(() => {
		let n = 0;
		let tMin = Infinity;
		let tMax = -Infinity;
		let v = 0;
		for (const s of series) {
			for (const p of s.points) {
				n++;
				if (p.ts < tMin) tMin = p.ts;
				if (p.ts > tMax) tMax = p.ts;
				if (p.v !== null && p.v > v) v = p.v;
			}
		}
		return {
			n,
			tMin: n ? tMin : 0,
			tMax: n ? tMax : 1,
			// Headroom so lines do not hug the top edge.
			vMax: max ?? Math.max(1, v) * 1.15
		};
	});
	const tMin = $derived(bounds.tMin);
	const tMax = $derived(bounds.tMax);
	const vMax = $derived(bounds.vMax);

	function x(ts: number): number {
		const span = Math.max(1, tMax - tMin);
		return PAD_L + ((ts - tMin) / span) * (W - PAD_L - PAD_R);
	}
	function y(v: number): number {
		return PAD_T + (1 - Math.min(v, vMax) / vMax) * (H - PAD_T - PAD_B);
	}

	function path(pts: { ts: number; v: number | null }[]): string {
		let d = '';
		for (const p of pts) {
			if (p.v === null) continue;
			d += `${d ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`;
		}
		return d;
	}

	function areaPath(pts: { ts: number; v: number | null }[]): string {
		const line = path(pts);
		if (!line) return '';
		const valid = pts.filter((p) => p.v !== null);
		if (valid.length === 0) return '';
		const first = valid[0];
		const last = valid[valid.length - 1];
		return `${line}L${x(last.ts).toFixed(1)},${y(0)}L${x(first.ts).toFixed(1)},${y(0)}Z`;
	}

	const gridTicks = $derived([0.25, 0.5, 0.75, 1].map((f) => f * vMax));

	// Path strings are derived once per series/bounds change; re-renders
	// from hover alone no longer rebuild them.
	const paths = $derived(series.map((s) => ({ d: path(s.points), area: areaPath(s.points) })));

	// Hover index tracks the longest series.
	const mainIdx = $derived.by(() => {
		let best = 0;
		for (let i = 1; i < series.length; i++) {
			if (series[i].points.length > series[best].points.length) best = i;
		}
		return best;
	});

	function fmt(v: number): string {
		if (format) return format(v);
		return `${v.toFixed(v >= 100 ? 0 : 1)}${unit}`;
	}

	function fmtTime(ts: number): string {
		const d = new Date(ts);
		// Multi-day ranges need a date on the axis, not just HH:MM.
		if (tMax - tMin > 86_400_000) {
			return d.toLocaleString(undefined, {
				month: 'short',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit'
			});
		}
		return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	}

	function onMove(e: PointerEvent, el: SVGSVGElement): void {
		const pts = series[mainIdx].points;
		if (pts.length === 0) return;
		const rect = el.getBoundingClientRect();
		const px = ((e.clientX - rect.left) / rect.width) * W;
		const ts = tMin + ((px - PAD_L) / (W - PAD_L - PAD_R)) * (tMax - tMin);
		// Points arrive ts-ascending; binary search beats a linear scan
		// on every pointermove.
		let lo = 0;
		let hi = pts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (pts[mid].ts < ts) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0 && Math.abs(pts[lo - 1].ts - ts) < Math.abs(pts[lo].ts - ts)) lo--;
		hover = lo;
	}
</script>

<div class="relative">
	<svg
		viewBox="0 0 {W} {H}"
		class="w-full touch-none select-none"
		style="height:{height}px"
		role="img"
		aria-label="metric chart"
		onpointermove={(e) => {
			onMove(e, e.currentTarget);
		}}
		onpointerleave={() => (hover = null)}
	>
		{#each gridTicks as g (g)}
			<line
				x1={PAD_L}
				y1={y(g)}
				x2={W - PAD_R}
				y2={y(g)}
				class="stroke-edge"
				stroke-dasharray="3 4"
				stroke-width="0.5"
			/>
			<text x={PAD_L - 6} y={y(g) + 3} text-anchor="end" class="fill-faint" font-size="9">
				{fmt(g)}
			</text>
		{/each}
		<text x={PAD_L} y={H - 6} class="fill-faint" font-size="9">{fmtTime(tMin)}</text>
		<text x={W - PAD_R} y={H - 6} text-anchor="end" class="fill-faint" font-size="9"
			>{fmtTime(tMax)}</text
		>

		{#each series as s, i (s.label)}
			<path d={paths[i].area} fill={s.color} opacity="0.08" />
			<path
				d={paths[i].d}
				fill="none"
				stroke={s.color}
				stroke-width="1.5"
				stroke-linejoin="round"
			/>
		{/each}

		{#if hover !== null}
			{@const pt = series[mainIdx].points.at(hover)}
			{#if pt}
				<line
					x1={x(pt.ts)}
					y1={PAD_T}
					x2={x(pt.ts)}
					y2={H - PAD_B}
					class="stroke-faint"
					stroke-width="0.75"
				/>
				{#each series as s (s.label)}
					{@const v = s.points.at(hover)?.v}
					{#if v !== null && v !== undefined}
						<circle cx={x(pt.ts)} cy={y(v)} r="2.5" fill={s.color} />
					{/if}
				{/each}
			{/if}
		{/if}
	</svg>

	{#if hover !== null}
		{@const pt = series[mainIdx].points.at(hover)}
		{#if pt}
			<div
				class="pointer-events-none absolute top-1 z-10 rounded-md border border-edge bg-raised/95 px-2 py-1 text-xs shadow-lg backdrop-blur"
				style="left: min(calc({(x(pt.ts) / W) * 100}% + 8px), calc(100% - 130px))"
			>
				<div class="text-faint">{new Date(pt.ts).toLocaleString()}</div>
				{#each series as s (s.label)}
					{@const v = s.points.at(hover)?.v}
					<div class="flex items-center gap-1.5">
						<span class="inline-block size-2 rounded-full" style="background:{s.color}"></span>
						<span class="text-muted">{s.label}</span>
						<span class="ml-auto font-mono text-fg"
							>{v === null || v === undefined ? '–' : fmt(v)}</span
						>
					</div>
				{/each}
			</div>
		{/if}
	{/if}

	{#if bounds.n === 0}
		<div class="absolute inset-0 flex items-center justify-center text-sm text-faint">
			No samples in range
		</div>
	{/if}
</div>
