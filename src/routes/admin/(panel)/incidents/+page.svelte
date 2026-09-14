<script lang="ts">
	import { onMount } from 'svelte';
	import { CircleCheck, MessageSquarePlus, Plus, Trash } from '@lucide/svelte';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import Modal from '$lib/components/admin/Modal.svelte';
	import ConfirmDialog from '$lib/components/admin/ConfirmDialog.svelte';
	import ServicePicker from '$lib/components/admin/ServicePicker.svelte';
	import { api, ApiError } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import { fmtDateTime } from '$lib/utils/format';
	import type { Incident } from '$lib/shared/types';

	let incidents = $state<{ active: Incident[]; recent: Incident[] }>({ active: [], recent: [] });
	let services = $state<{ id: string; name: string }[]>([]);
	let loading = $state(true);

	let createOpen = $state(false);
	let updateTarget = $state<Incident | null>(null);
	let updateOpen = $state(false);
	let updateMessage = $state('');
	let resolveTarget = $state<Incident | null>(null);
	let resolveOpen = $state(false);
	let deleteTarget = $state<Incident | null>(null);
	let deleteOpen = $state(false);
	let busy = $state(false);

	// create form
	let title = $state('');
	let severity = $state<'minor' | 'major'>('minor');
	let selected = $state<string[]>([]);
	let message = $state('');

	async function load(): Promise<void> {
		try {
			const [inc, svc] = await Promise.all([
				api<{ active: Incident[]; recent: Incident[] }>('/incidents'),
				api<{ value: { id: string; name: string }[] }>('/sections/services')
			]);
			incidents = inc;
			services = Array.isArray(svc.value) ? svc.value : [];
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'load failed');
		} finally {
			loading = false;
		}
	}

	onMount(load);

	async function create(): Promise<void> {
		busy = true;
		try {
			await api('/incidents', {
				body: { title, severity, services: selected, message: message || undefined }
			});
			toast('success', 'Incident published');
			createOpen = false;
			title = '';
			message = '';
			severity = 'minor';
			selected = [];
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'create failed');
		} finally {
			busy = false;
		}
	}

	async function postUpdate(): Promise<void> {
		if (!updateTarget) return;
		busy = true;
		try {
			await api(`/incidents/${updateTarget.id}`, { body: { message: updateMessage } });
			toast('success', 'Update posted');
			updateTarget = null;
			updateOpen = false;
			updateMessage = '';
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'update failed');
		} finally {
			busy = false;
		}
	}

	async function resolve(): Promise<void> {
		if (!resolveTarget) return;
		busy = true;
		try {
			await api(`/incidents/${resolveTarget.id}`, { method: 'PATCH' });
			toast('success', 'Incident resolved');
			resolveTarget = null;
			resolveOpen = false;
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'resolve failed');
		} finally {
			busy = false;
		}
	}

	async function remove(): Promise<void> {
		if (!deleteTarget) return;
		busy = true;
		try {
			await api(`/incidents/${deleteTarget.id}`, { method: 'DELETE' });
			toast('success', 'Incident deleted');
			deleteTarget = null;
			deleteOpen = false;
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'delete failed');
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader title="Incidents" description="Manual notices plus monitor-detected outages">
	<button class="btn btn-primary" onclick={() => (createOpen = true)}>
		<Plus class="size-4" /> New incident
	</button>
</PageHeader>

{#if loading}
	<div class="space-y-3">
		<div class="card h-28 animate-pulse"></div>
		<div class="card h-28 animate-pulse"></div>
	</div>
{:else}
	<section>
		<h2 class="mb-3 text-sm font-semibold">Active</h2>
		{#if incidents.active.length === 0}
			<div class="card p-6 text-center">
				<p class="flex items-center justify-center gap-2 text-sm text-up-fg">
					<CircleCheck class="size-4" /> No active incidents
				</p>
			</div>
		{:else}
			<div class="space-y-3">
				{#each incidents.active as inc (inc.id)}
					<div class="card p-4">
						<div class="flex items-start justify-between gap-3">
							<div class="min-w-0">
								<div class="flex items-center gap-2">
									<span class="text-sm font-medium">{inc.title}</span>
									<span
										class="chip {inc.severity === 'major' ? 'border-down/50 text-down-fg' : ''}"
									>
										{inc.severity}
									</span>
									<span class="chip">{inc.source}</span>
								</div>
								<p class="mt-1 text-xs text-faint">
									since {fmtDateTime(inc.startedAt)} · {inc.services.join(', ')}
								</p>
							</div>
							<div class="flex shrink-0 gap-1">
								<button
									class="btn btn-sm"
									onclick={() => {
										updateTarget = inc;
										updateMessage = '';
										updateOpen = true;
									}}
								>
									<MessageSquarePlus class="size-3.5" /> Update
								</button>
								<button
									class="btn btn-sm"
									onclick={() => {
										resolveTarget = inc;
										resolveOpen = true;
									}}
								>
									Resolve
								</button>
							</div>
						</div>
						{#if inc.updates.length > 0}
							<ul class="mt-3 space-y-1 border-t border-edge pt-3">
								{#each inc.updates as u (u.at)}
									<li class="text-xs text-muted">
										<span class="text-faint">{fmtDateTime(u.at)}:</span>
										{u.message}
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</section>

	<section class="mt-8">
		<h2 class="mb-3 text-sm font-semibold">Recent</h2>
		{#if incidents.recent.length === 0}
			<div class="card p-6 text-center">
				<p class="flex items-center justify-center gap-2 text-sm text-faint">
					<CircleCheck class="size-4" /> No resolved incidents
				</p>
			</div>
		{:else}
			<div class="card divide-y divide-edge">
				{#each incidents.recent as inc (inc.id)}
					<div class="flex items-center justify-between gap-3 px-4 py-3">
						<div class="min-w-0">
							<p class="truncate text-sm">{inc.title}</p>
							<p class="text-xs text-faint">
								{fmtDateTime(inc.startedAt)} - {inc.resolvedAt ? fmtDateTime(inc.resolvedAt) : ''} · {inc.source}
							</p>
						</div>
						{#if inc.source === 'manual'}
							<button
								class="btn btn-ghost btn-sm text-down-fg"
								title="Delete"
								onclick={() => {
									deleteTarget = inc;
									deleteOpen = true;
								}}
							>
								<Trash class="size-3.5" />
							</button>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</section>
{/if}

<!-- Create -->
<Modal bind:open={createOpen} title="New incident" wide>
	<form
		class="space-y-4"
		onsubmit={(e) => {
			e.preventDefault();
			void create();
		}}
	>
		<Field label="Title" required>
			<input class="input" bind:value={title} placeholder="Elevated API errors" required />
		</Field>
		<div class="grid grid-cols-2 gap-3">
			<Field label="Severity" required>
				<select class="input" bind:value={severity}>
					<option value="minor">minor</option>
					<option value="major">major</option>
				</select>
			</Field>
		</div>
		<Field label="Affected services" required>
			<ServicePicker {services} bind:selected />
		</Field>
		<Field label="First update" hint="Optional message shown in the incident timeline.">
			<textarea class="input h-20" bind:value={message}></textarea>
		</Field>
		<div class="flex justify-end gap-2">
			<button type="button" class="btn" onclick={() => (createOpen = false)}>Cancel</button>
			<button
				type="submit"
				class="btn btn-primary"
				disabled={busy || !title || selected.length === 0}
			>
				Publish
			</button>
		</div>
	</form>
</Modal>

<!-- Post update -->
<Modal bind:open={updateOpen} title="Post update">
	<form
		class="space-y-4"
		onsubmit={(e) => {
			e.preventDefault();
			void postUpdate();
		}}
	>
		<p class="text-sm text-muted">{updateTarget?.title}</p>
		<Field label="Message" required>
			<textarea class="input h-24" bind:value={updateMessage} required></textarea>
		</Field>
		<div class="flex justify-end gap-2">
			<button type="button" class="btn" onclick={() => (updateOpen = false)}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={busy || !updateMessage.trim()}>
				Post
			</button>
		</div>
	</form>
</Modal>

<ConfirmDialog
	bind:open={resolveOpen}
	title="Resolve incident?"
	description={`"${resolveTarget?.title ?? 'This incident'}" will be marked resolved.`}
	confirmLabel="Resolve"
	onconfirm={() => void resolve()}
/>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Delete incident?"
	description={`"${deleteTarget?.title ?? 'This incident'}" will be removed permanently.`}
	confirmLabel="Delete"
	danger
	onconfirm={() => void remove()}
/>
