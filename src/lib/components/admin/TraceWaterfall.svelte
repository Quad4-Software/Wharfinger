<script lang="ts">
	import { fmtMs } from '$lib/utils/format';

	interface WaterfallSpan {
		spanId: string;
		parentSpanId: string | null;
		op: string | null;
		description: string | null;
		startMs: number;
		endMs: number;
		status: string | null;
	}

	interface Props {
		name: string;
		op: string | null;
		spanId: string | null;
		startMs: number;
		durationMs: number;
		status: string | null;
		spans: WaterfallSpan[];
	}

	const { name, op, spanId, startMs, durationMs, status, spans }: Props = $props();

	interface Row {
		key: string;
		op: string;
		label: string;
		start: number;
		end: number;
		depth: number;
		err: boolean;
	}

	// Flatten the parent_span_id tree depth-first so children render
	// under their parent; orphans (dangling parent ids, cycles) get
	// appended by start time instead of vanishing.
	const rows = $derived.by((): Row[] => {
		const kids: Record<string, WaterfallSpan[]> = {};
		for (const s of spans) {
			if (!s.parentSpanId) continue;
			(kids[s.parentSpanId] ??= []).push(s);
		}
		for (const list of Object.values(kids)) list.sort((a, b) => a.startMs - b.startMs);
		const out: Row[] = [];
		const seen: Record<string, boolean> = {};
		const push = (
			s: Pick<WaterfallSpan, 'spanId' | 'op' | 'description' | 'startMs' | 'endMs' | 'status'>,
			depth: number
		) => {
			if (seen[s.spanId]) return;
			seen[s.spanId] = true;
			out.push({
				key: s.spanId,
				op: s.op ?? 'span',
				label: s.description ?? '',
				start: s.startMs,
				end: s.endMs,
				depth,
				err: s.status !== null && s.status !== 'ok'
			});
			for (const k of kids[s.spanId] ?? []) push(k, depth + 1);
		};
		out.push({
			key: 'root',
			op: op ?? 'transaction',
			label: name,
			start: startMs,
			end: startMs + durationMs,
			depth: 0,
			err: status !== null && status !== 'ok'
		});
		if (spanId) {
			seen[spanId] = true;
			for (const k of kids[spanId] ?? []) push(k, 1);
		}
		for (const s of [...spans].sort((a, b) => a.startMs - b.startMs)) {
			if (!seen[s.spanId]) push(s, 1);
		}
		return out;
	});

	const total = $derived(Math.max(1, durationMs));
	const offset = (ms: number): string =>
		`${Math.min(100, Math.max(0, ((ms - startMs) / total) * 100))}%`;
	const width = (ms: number): string => `${Math.max(0.6, Math.min(100, (ms / total) * 100))}%`;
</script>

<div class="overflow-x-auto">
	<div class="min-w-[32rem]">
		{#each rows as r (r.key)}
			<div
				class="grid grid-cols-[minmax(0,16rem)_1fr_4.5rem] items-center gap-2 border-b border-edge/50 py-1"
			>
				<div class="flex min-w-0 items-baseline gap-1.5" style="padding-left: {r.depth * 14}px">
					<span
						class="shrink-0 text-[11px] font-medium {r.depth === 0 ? 'text-fg' : 'text-accent'}"
					>
						{r.op}
					</span>
					{#if r.label}
						<span class="truncate text-[11px] text-faint" title={r.label}>{r.label}</span>
					{/if}
				</div>
				<div class="relative h-3.5 rounded bg-raised">
					<div
						class="absolute inset-y-0 rounded {r.err ? 'bg-down' : 'bg-accent/70'}"
						style="left: {offset(r.start)}; width: {width(r.end - r.start)}"
					></div>
				</div>
				<span class="text-right text-[11px] {r.err ? 'text-down' : 'text-faint'}">
					{fmtMs(r.end - r.start)}
				</span>
			</div>
		{/each}
	</div>
</div>
