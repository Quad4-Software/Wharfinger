<script lang="ts">
	import Field from './Field.svelte';
	import Modal from './Modal.svelte';
	import ServicePicker from './ServicePicker.svelte';
	import { WEEKDAYS, weeklyOccurrences } from '$lib/shared/maintenance';
	import { fmtDateTime } from '$lib/utils/format';

	import type { MaintDraft } from '$lib/shared/drafts';

	let {
		open = $bindable(false),
		window_,
		services,
		onsave
	}: {
		open?: boolean;
		window_: MaintDraft | null;
		services: { id: string; name: string }[];
		onsave: (draft: MaintDraft) => void;
	} = $props();

	let mode = $state<'once' | 'weekly'>('once');
	let title = $state('');
	let description = $state('');
	let selected = $state<string[]>(['all']);
	let startLocal = $state('');
	let endLocal = $state('');
	let weekday = $state('tue');
	let at = $state('02:00');
	let duration = $state(60);
	let error = $state<string | null>(null);

	function isoToLocal(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}
	function localToIso(v: string): string | undefined {
		if (!v) return undefined;
		const d = new Date(v);
		return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
	}

	$effect(() => {
		if (open) {
			title = window_?.title ?? '';
			description = window_?.description ?? '';
			selected = window_?.services.length ? [...window_.services] : ['all'];
			mode = window_?.weekly ? 'weekly' : 'once';
			startLocal = window_?.start ? isoToLocal(window_.start) : '';
			endLocal = window_?.end ? isoToLocal(window_.end) : '';
			weekday = window_?.weekly ?? 'tue';
			at = window_?.at ?? '02:00';
			duration = window_?.duration_minutes ?? 60;
			error = null;
		}
	});

	function submit(): void {
		error = null;
		if (!title.trim()) {
			error = 'title is required';
			return;
		}
		if (selected.length === 0) {
			error = 'select at least one service';
			return;
		}
		const out: MaintDraft = {
			...(window_?.id ? { id: window_.id } : {}),
			title: title.trim(),
			services: selected
		};
		if (description.trim()) out.description = description.trim();
		if (mode === 'once') {
			const s = localToIso(startLocal);
			const e = localToIso(endLocal);
			if (!s || !e) {
				error = 'start and end are required';
				return;
			}
			if (Date.parse(e) <= Date.parse(s)) {
				error = 'end must be after start';
				return;
			}
			out.start = s;
			out.end = e;
		} else {
			if (!/^\d{2}:\d{2}$/.test(at)) {
				error = 'time must be HH:MM';
				return;
			}
			out.weekly = weekday;
			out.at = at;
			out.duration_minutes = duration;
		}
		onsave(out);
		open = false;
	}
</script>

<Modal bind:open title={window_ ? 'Edit window' : 'Schedule maintenance'} wide>
	<form
		class="space-y-4"
		onsubmit={(e) => {
			e.preventDefault();
			submit();
		}}
	>
		<Field label="Title" required>
			<input class="input" bind:value={title} placeholder="Cluster upgrade" required />
		</Field>
		<Field label="Description" hint="Shown on the status page.">
			<input class="input" bind:value={description} />
		</Field>
		<Field label="Affected services" required>
			<ServicePicker {services} bind:selected />
		</Field>

		<div class="grid grid-cols-2 gap-2 rounded-lg border border-edge p-1">
			<button
				type="button"
				class="btn {mode === 'once' ? 'btn-primary' : 'btn-ghost'}"
				onclick={() => (mode = 'once')}>One-shot</button
			>
			<button
				type="button"
				class="btn {mode === 'weekly' ? 'btn-primary' : 'btn-ghost'}"
				onclick={() => (mode = 'weekly')}>Weekly recurring</button
			>
		</div>

		{#if mode === 'once'}
			<div class="grid grid-cols-2 gap-3">
				<Field label="Starts" required>
					<input class="input" type="datetime-local" bind:value={startLocal} required />
				</Field>
				<Field label="Ends" required>
					<input class="input" type="datetime-local" bind:value={endLocal} required />
				</Field>
			</div>
			<p class="text-xs text-faint">Times are in your local timezone and stored as UTC.</p>
		{:else}
			<div class="grid grid-cols-3 gap-3">
				<Field label="Weekday" required>
					<select class="input" bind:value={weekday}>
						{#each WEEKDAYS as d (d)}
							<option value={d}>{d}</option>
						{/each}
					</select>
				</Field>
				<Field label="At (UTC)" required hint="24h, UTC">
					<input class="input font-mono" bind:value={at} placeholder="02:00" required />
				</Field>
				<Field label="Duration (min)" required>
					<input class="input" type="number" min="1" max="10080" bind:value={duration} required />
				</Field>
			</div>
			{@const preview = /^\d{2}:\d{2}$/.test(at)
				? weeklyOccurrences(weekday, at, duration, Date.now(), Date.now() + 28 * 86_400_000)
				: []}
			{#if preview.length > 0}
				<p class="text-xs text-faint">
					Next occurrences (UTC): {preview
						.slice(0, 3)
						.map((o) => fmtDateTime(new Date(o.start).toISOString()))
						.join(' · ')}
				</p>
			{/if}
		{/if}

		{#if error}<p class="text-sm text-down-fg" role="alert">{error}</p>{/if}
		<div class="flex justify-end gap-2 pt-1">
			<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
			<button type="submit" class="btn btn-primary">
				{window_ ? 'Save' : 'Schedule'}
			</button>
		</div>
	</form>
</Modal>
