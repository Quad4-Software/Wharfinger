<script lang="ts">
	import { ChevronLeft, ChevronRight, X } from '@lucide/svelte';

	// Month-grid calendar. Events carry an ms epoch start/end and render as
	// chips on every day they touch, with continuation edges on multi-day
	// spans. Clicking a day opens a detail list below the grid. Everything
	// is computed in the viewer's local timezone; callers pass
	// already-expanded occurrences.
	export interface CalEvent {
		title: string;
		startMs: number;
		endMs: number;
		// Semantic tone used for the chip color.
		tone: 'maint' | 'incident' | 'info';
		href?: string;
	}

	const { events }: { events: CalEvent[] } = $props();

	let cursor = $state(new Date());
	let selected = $state<number | null>(null);

	const year = $derived(cursor.getFullYear());
	const month = $derived(cursor.getMonth());
	const monthLabel = $derived(cursor.toLocaleString(undefined, { month: 'long', year: 'numeric' }));

	const TONE_CHIP: Record<CalEvent['tone'], string> = {
		incident: 'bg-down/15 text-down border-down/30',
		maint: 'bg-maint/15 text-maint border-maint/30',
		info: 'bg-accent/15 text-accent border-accent/30'
	};
	const TONE_DOT: Record<CalEvent['tone'], string> = {
		incident: 'bg-down',
		maint: 'bg-maint',
		info: 'bg-accent'
	};
	const TONE_LABEL: Record<CalEvent['tone'], string> = {
		incident: 'incident',
		maint: 'maintenance',
		info: 'event'
	};

	function fmtTime(ms: number): string {
		return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	}
	function fmtRange(e: CalEvent, dayStart: number): string {
		const sameStart = e.startMs >= dayStart && e.startMs < dayStart + 86_400_000;
		const sameEnd = e.endMs >= dayStart && e.endMs < dayStart + 86_400_000;
		if (sameStart && sameEnd) return `${fmtTime(e.startMs)} - ${fmtTime(e.endMs)}`;
		if (sameStart) return `from ${fmtTime(e.startMs)}`;
		if (sameEnd) return `until ${fmtTime(e.endMs)}`;
		return 'all day';
	}

	interface Cell {
		date: Date;
		dayStart: number;
		inMonth: boolean;
		isWeekend: boolean;
		isToday: boolean;
		events: { ev: CalEvent; startsHere: boolean; endsHere: boolean }[];
	}

	// Monday-first grid cells covering the visible month.
	const cells = $derived.by<Cell[]>(() => {
		const first = new Date(year, month, 1);
		const last = new Date(year, month + 1, 0);
		const lead = (first.getDay() + 6) % 7; // Mon=0
		const todayKey = new Date().toDateString();
		const out: Cell[] = [];
		const total = Math.ceil((lead + last.getDate()) / 7) * 7;
		for (let i = 0; i < total; i++) {
			const d = new Date(year, month, 1 + i - lead);
			const dayStart = d.getTime();
			const dayEnd = dayStart + 86_400_000;
			out.push({
				date: d,
				dayStart,
				inMonth: d.getMonth() === month,
				isWeekend: d.getDay() === 0 || d.getDay() === 6,
				isToday: d.toDateString() === todayKey,
				events: events
					.filter((e) => e.startMs < dayEnd && e.endMs >= dayStart)
					.map((ev) => ({
						ev,
						startsHere: ev.startMs >= dayStart,
						endsHere: ev.endMs < dayEnd
					}))
			});
		}
		return out;
	});

	const selectedCell = $derived(cells.find((c) => c.dayStart === selected) ?? null);

	function shift(delta: number): void {
		cursor = new Date(year, month + delta, 1);
		selected = null;
	}

	function pick(c: Cell): void {
		selected = selected === c.dayStart ? null : c.dayStart;
	}

	function cellKey(e: KeyboardEvent, c: Cell): void {
		// Links inside the cell keep their own Enter behavior.
		if (e.target !== e.currentTarget) return;
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			pick(c);
		}
	}

	function onKey(e: KeyboardEvent): void {
		if (e.key === 'ArrowLeft') shift(-1);
		else if (e.key === 'ArrowRight') shift(1);
	}
</script>

<div class="card p-4">
	<div class="mb-3 flex items-center justify-between">
		<h2 class="text-sm font-semibold">{monthLabel}</h2>
		<div class="flex items-center gap-1">
			<button
				class="btn btn-ghost btn-sm"
				onclick={() => {
					cursor = new Date();
					selected = null;
				}}
				title="Jump to today">Today</button
			>
			<button
				class="btn btn-ghost btn-sm"
				onclick={() => {
					shift(-1);
				}}
				aria-label="Previous month"
			>
				<ChevronLeft class="size-4" />
			</button>
			<button
				class="btn btn-ghost btn-sm"
				onclick={() => {
					shift(1);
				}}
				aria-label="Next month"
			>
				<ChevronRight class="size-4" />
			</button>
		</div>
	</div>
	<div
		class="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-edge bg-edge/60"
		role="grid"
		tabindex="0"
		onkeydown={onKey}
		aria-label="Calendar, use arrow keys to change month"
	>
		{#each ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as d (d)}
			<div class="bg-panel px-2 py-1.5 text-center text-[11px] font-medium text-faint">{d}</div>
		{/each}
		{#each cells as c (c.dayStart)}
			<div
				role="button"
				tabindex="0"
				class="min-h-16 bg-panel p-1.5 text-left align-top transition-colors sm:min-h-20
					{!c.inMonth ? 'opacity-40' : ''}
					{c.isWeekend ? 'bg-overlay/[0.03]' : ''}
					{c.isToday ? 'ring-1 ring-accent/60 ring-inset' : ''}
					{selected === c.dayStart ? 'ring-1 ring-accent ring-inset' : ''}
					{c.events.length > 0 ? 'cursor-pointer hover:bg-overlay/5' : 'cursor-default'}"
				onclick={() => {
					pick(c);
				}}
				onkeydown={(e) => {
					cellKey(e, c);
				}}
				aria-label="{c.date.toDateString()}{c.events.length > 0
					? `, ${c.events.length} events`
					: ''}"
			>
				<div class="mb-1 flex items-center justify-between">
					<span class="text-[10px] text-faint sm:hidden">
						{c.date.toLocaleString(undefined, { weekday: 'narrow' })}
					</span>
					<span
						class="ml-auto text-[11px] {c.isToday
							? 'flex size-5 items-center justify-center rounded-full bg-accent font-semibold text-bg'
							: 'text-faint'}"
					>
						{c.date.getDate()}
					</span>
				</div>
				<!-- Text chips on sm+, dots on the smallest screens -->
				<div class="hidden space-y-0.5 sm:block">
					{#each c.events.slice(0, 3) as item (`${item.ev.title}-${item.ev.startMs}`)}
						{@const cls = `block truncate border-y px-1 py-0.5 text-[10px] leading-tight ${TONE_CHIP[item.ev.tone]} ${item.startsHere ? 'rounded-l border-l' : '-ml-1.5 pl-2'} ${item.endsHere ? 'rounded-r border-r' : '-mr-1.5'}`}
						{#if item.ev.href}
							<a
								href={item.ev.href}
								class={cls}
								title={item.ev.title}
								onclick={(e) => {
									e.stopPropagation();
								}}
							>
								{item.ev.title}
							</a>
						{:else}
							<span class={cls} title={item.ev.title}>{item.ev.title}</span>
						{/if}
					{/each}
					{#if c.events.length > 3}
						<span class="block px-1 text-[10px] font-medium text-accent">
							+{c.events.length - 3} more
						</span>
					{/if}
				</div>
				<div class="flex flex-wrap gap-1 sm:hidden">
					{#each c.events.slice(0, 5) as item (`${item.ev.title}-${item.ev.startMs}-dot`)}
						<span class="size-1.5 rounded-full {TONE_DOT[item.ev.tone]}"></span>
					{/each}
					{#if c.events.length > 5}
						<span class="text-[9px] text-faint">+{c.events.length - 5}</span>
					{/if}
				</div>
			</div>
		{/each}
	</div>

	{#if selectedCell}
		<div class="mt-3 rounded-lg border border-edge bg-overlay/[0.03] p-3">
			<div class="mb-2 flex items-center justify-between">
				<h3 class="text-xs font-semibold">
					{selectedCell.date.toLocaleDateString(undefined, {
						weekday: 'long',
						month: 'long',
						day: 'numeric'
					})}
				</h3>
				<button
					class="btn btn-ghost btn-sm !p-1"
					onclick={() => (selected = null)}
					aria-label="Close day detail"
				>
					<X class="size-3.5" />
				</button>
			</div>
			{#if selectedCell.events.length === 0}
				<p class="text-xs text-faint">No events this day.</p>
			{:else}
				<ul class="space-y-1.5">
					{#each selectedCell.events as item (`${item.ev.title}-${item.ev.startMs}-detail`)}
						<li class="flex items-start gap-2 text-xs">
							<span class="mt-1.5 size-2 shrink-0 rounded-full {TONE_DOT[item.ev.tone]}"></span>
							<div class="min-w-0 flex-1">
								{#if item.ev.href}
									<a
										href={item.ev.href}
										class="font-medium text-fg hover:text-accent hover:underline"
									>
										{item.ev.title}
									</a>
								{:else}
									<span class="font-medium text-fg">{item.ev.title}</span>
								{/if}
								<div class="text-[11px] text-faint">
									{TONE_LABEL[item.ev.tone]} · {fmtRange(item.ev, selectedCell.dayStart)}
								</div>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>
