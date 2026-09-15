<script lang="ts">
	import { ArrowUpToLine, Power, RefreshCw } from '@lucide/svelte';
	import Modal from '$lib/components/admin/Modal.svelte';
	import { api, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import type { AgentView } from '$lib/shared/agents';

	const {
		agent,
		canManage,
		onqueued
	}: {
		agent: AgentView;
		canManage: boolean;
		onqueued?: () => void;
	} = $props();

	const updates = $derived(agent.summary?.updates ?? null);
	const muted = $derived(agent.mutedUntil !== null && agent.mutedUntil > Date.now());

	let busy = $state(false);
	let rebootOpen = $state(false);
	let applyOpen = $state(false);
	let securityOnly = $state(true);
	let rebootAt = $state('');

	async function task(action: string, extra: Record<string, unknown> = {}): Promise<void> {
		busy = true;
		try {
			await api(`/agents/${agent.id}/task`, { method: 'POST', body: { action, ...extra } });
			toast('success', 'Task queued');
			onqueued?.();
		} catch (err) {
			toast('error', errMessage(err));
		} finally {
			busy = false;
		}
	}

	async function reboot(): Promise<void> {
		const extra: Record<string, unknown> = {};
		if (rebootAt) {
			const at = Date.parse(rebootAt);
			if (Number.isFinite(at)) extra.at = at;
		}
		rebootOpen = false;
		rebootAt = '';
		await task('host.reboot', extra);
	}
</script>

{#if updates ?? canManage}
	<div class="card mt-4 p-4">
		<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
			<h2 class="flex items-center gap-1.5 text-sm font-medium text-muted">
				<ArrowUpToLine class="size-4" /> Host operations
			</h2>
			{#if muted}
				<span
					class="rounded-md border border-degraded/40 bg-degraded/10 px-1.5 py-0.5 text-xs text-degraded"
				>
					reboot muted until {new Date(agent.mutedUntil ?? 0).toLocaleTimeString()}
				</span>
			{/if}
		</div>

		{#if updates}
			<div class="mb-3 flex flex-wrap gap-x-6 gap-y-1.5 text-xs">
				<span class="text-faint"
					>manager <span class="font-mono text-muted">{updates.manager}</span></span
				>
				<span class="text-faint">
					pending
					<span class="font-mono {updates.pending > 0 ? 'text-degraded' : 'text-up'}">
						{updates.pending}
					</span>
				</span>
				<span class="text-faint">
					security
					<span class="font-mono {updates.security > 0 ? 'text-down' : 'text-up'}">
						{updates.security}
					</span>
				</span>
				{#if updates.rebootRequired}
					<span class="text-degraded">reboot required</span>
				{/if}
			</div>
		{/if}

		{#if canManage}
			<div class="flex flex-wrap items-center gap-2">
				<button
					class="btn btn-ghost !px-2.5 !py-1 text-xs"
					disabled={busy}
					onclick={() => task('packages.refresh')}
				>
					<RefreshCw class="size-3.5" /> Refresh index
				</button>
				<button
					class="btn btn-ghost !px-2.5 !py-1 text-xs"
					disabled={busy}
					onclick={() => {
						securityOnly = true;
						applyOpen = true;
					}}
				>
					<ArrowUpToLine class="size-3.5" /> Apply updates
				</button>
				<button
					class="btn btn-ghost !px-2.5 !py-1 text-xs text-down"
					disabled={busy}
					onclick={() => (rebootOpen = true)}
				>
					<Power class="size-3.5" /> Reboot
				</button>
			</div>
		{/if}
	</div>
{/if}

<Modal bind:open={rebootOpen} title="Reboot host">
	<div class="space-y-3 text-sm text-muted">
		<p>
			The host reboots when the agent claims the job. Offline alerts are muted for a 30 minute drain
			window.
		</p>
		<label class="block text-xs">
			<span class="mb-1 block text-faint">Schedule (optional, local time)</span>
			<input class="input" type="datetime-local" bind:value={rebootAt} />
		</label>
		<div class="flex justify-end gap-2 pt-1">
			<button class="btn" onclick={() => (rebootOpen = false)}>Cancel</button>
			<button class="btn btn-danger" disabled={busy} onclick={reboot}>Reboot</button>
		</div>
	</div>
</Modal>

<Modal bind:open={applyOpen} title="Apply package updates">
	<div class="space-y-3 text-sm text-muted">
		<p>Queued on the agent. Output streams to the job log.</p>
		<label class="flex items-center gap-2 text-xs">
			<input type="checkbox" bind:checked={securityOnly} />
			Security updates only (falls back to a full upgrade on apt)
		</label>
		<div class="flex justify-end gap-2 pt-1">
			<button class="btn" onclick={() => (applyOpen = false)}>Cancel</button>
			<button
				class="btn btn-primary"
				disabled={busy}
				onclick={() => {
					applyOpen = false;
					void task('packages.apply', { securityOnly });
				}}
			>
				Apply
			</button>
		</div>
	</div>
</Modal>
