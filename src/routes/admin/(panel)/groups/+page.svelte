<script lang="ts">
	import { onMount } from 'svelte';
	import { FolderPlus, Pencil, Plus, Trash, Users } from '@lucide/svelte';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import Modal from '$lib/components/admin/Modal.svelte';
	import ConfirmDialog from '$lib/components/admin/ConfirmDialog.svelte';
	import { api, ApiError, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import type { GroupMember, ServiceGroup } from '$lib/shared/groups';

	interface PickerService {
		id: string;
		name: string;
	}
	interface PickerApp {
		id: string;
		name: string;
	}

	let groups = $state<ServiceGroup[]>([]);
	let services = $state<PickerService[]>([]);
	let apps = $state<PickerApp[]>([]);
	let loading = $state(true);
	let busy = $state(false);

	let editTarget = $state<ServiceGroup | null>(null);
	let editOpen = $state(false);
	let name = $state('');
	let color = $state('');

	let memberTarget = $state<ServiceGroup | null>(null);
	let memberOpen = $state(false);
	let selServices = $state<string[]>([]);
	let selApps = $state<string[]>([]);

	let deleteTarget = $state<ServiceGroup | null>(null);
	let deleteOpen = $state(false);

	async function load(): Promise<void> {
		try {
			const [g, ov, ap] = await Promise.all([
				api<{ groups: ServiceGroup[] }>('/groups'),
				api<{ services: PickerService[] }>('/overview').catch(() => ({
					services: [] as PickerService[]
				})),
				api<{ apps: PickerApp[] }>('/deploy/apps').catch(() => ({ apps: [] as PickerApp[] }))
			]);
			groups = g.groups;
			services = ov.services;
			apps = ap.apps;
		} catch (err) {
			toast('error', errMessage(err, 'load failed'));
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function openEdit(g: ServiceGroup | null): void {
		editTarget = g;
		name = g?.name ?? '';
		color = g?.color ?? '';
		editOpen = true;
	}

	function openMembers(g: ServiceGroup): void {
		memberTarget = g;
		selServices = g.members.filter((m) => m.memberKind === 'service').map((m) => m.memberId);
		selApps = g.members.filter((m) => m.memberKind === 'app').map((m) => m.memberId);
		memberOpen = true;
	}

	function toggle(list: string[], id: string): string[] {
		return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
	}

	function memberLabel(m: GroupMember): string {
		if (m.memberKind === 'service') {
			return services.find((s) => s.id === m.memberId)?.name ?? m.memberId;
		}
		return apps.find((a) => a.id === m.memberId)?.name ?? m.memberId;
	}

	async function save(): Promise<void> {
		busy = true;
		try {
			const body = { name: name.trim(), color: color.trim() === '' ? null : color.trim() };
			if (editTarget) {
				await api(`/groups/${editTarget.id}`, { method: 'PATCH', body });
				toast('success', 'Group updated');
			} else {
				await api('/groups', { body });
				toast('success', 'Group created');
			}
			editOpen = false;
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'save failed');
		} finally {
			busy = false;
		}
	}

	async function saveMembers(): Promise<void> {
		if (!memberTarget) return;
		busy = true;
		try {
			const before = memberTarget.members;
			const add: GroupMember[] = [
				...selServices.map((memberId) => ({ memberKind: 'service' as const, memberId })),
				...selApps.map((memberId) => ({ memberKind: 'app' as const, memberId }))
			].filter(
				(m) => !before.some((b) => b.memberKind === m.memberKind && b.memberId === m.memberId)
			);
			const remove = before.filter(
				(b) =>
					(b.memberKind === 'service' && !selServices.includes(b.memberId)) ||
					(b.memberKind === 'app' && !selApps.includes(b.memberId))
			);
			await api(`/groups/${memberTarget.id}/members`, { method: 'PUT', body: { add, remove } });
			toast('success', 'Membership updated');
			memberOpen = false;
			await load();
		} catch (err) {
			toast('error', errMessage(err, 'membership save failed'));
		} finally {
			busy = false;
		}
	}

	async function remove(): Promise<void> {
		if (!deleteTarget) return;
		busy = true;
		try {
			await api(`/groups/${deleteTarget.id}`, { method: 'DELETE' });
			toast('success', 'Group deleted');
			deleteOpen = false;
			await load();
		} catch (err) {
			toast('error', errMessage(err, 'delete failed'));
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader title="Groups" description="Named sets of services and apps for filtering and teams">
	<button
		class="btn btn-primary"
		onclick={() => {
			openEdit(null);
		}}
	>
		<Plus class="size-4" /> New group
	</button>
</PageHeader>

{#if loading}
	<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
		{#each [0, 1, 2] as i (i)}
			<div class="card h-28 animate-pulse"></div>
		{/each}
	</div>
{:else if groups.length === 0}
	<div class="card p-10 text-center">
		<FolderPlus class="mx-auto mb-3 size-8 text-faint" />
		<p class="text-muted">No groups yet.</p>
		<p class="mt-1 text-xs text-faint">
			Group services and apps to filter dashboards and scope team visibility.
		</p>
		<button
			class="btn btn-primary mt-4"
			onclick={() => {
				openEdit(null);
			}}
		>
			<Plus class="size-4" /> Create one
		</button>
	</div>
{:else}
	<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
		{#each groups as g (g.id)}
			<div class="card p-4">
				<div class="flex items-center justify-between gap-2">
					<span class="flex min-w-0 items-center gap-2">
						<span
							class="size-2.5 shrink-0 rounded-full border border-edge"
							style={g.color ? `background-color: ${g.color}` : ''}
							aria-hidden="true"
						></span>
						<span class="truncate text-sm font-semibold">{g.name}</span>
					</span>
					<span class="chip chip-muted">{g.memberCount}</span>
				</div>
				<div class="mt-2 flex flex-wrap gap-1">
					{#each g.members as m (`${m.memberKind}:${m.memberId}`)}
						<span class="chip">{memberLabel(m)}</span>
					{:else}
						<span class="text-xs text-faint">No members</span>
					{/each}
				</div>
				<div class="mt-3 flex gap-1 border-t border-edge pt-3">
					<button
						class="btn btn-ghost btn-sm"
						onclick={() => {
							openMembers(g);
						}}
					>
						<Users class="size-3.5" /> Members
					</button>
					<button
						class="btn btn-ghost btn-sm"
						onclick={() => {
							openEdit(g);
						}}
					>
						<Pencil class="size-3.5" /> Edit
					</button>
					<button
						class="btn btn-ghost btn-sm ml-auto text-down-fg"
						aria-label="Delete {g.name}"
						onclick={() => {
							deleteTarget = g;
							deleteOpen = true;
						}}
					>
						<Trash class="size-3.5" />
					</button>
				</div>
			</div>
		{/each}
	</div>
{/if}

<Modal bind:open={editOpen} title={editTarget ? `Edit ${editTarget.name}` : 'New group'}>
	<form
		class="space-y-4"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<Field label="Name" required>
			<input class="input" bind:value={name} placeholder="production" required maxlength="64" />
		</Field>
		<Field label="Color" hint="Optional hex color like #3b82f6; leave empty for none">
			<input class="input font-mono" bind:value={color} placeholder="#3b82f6" />
		</Field>
		<div class="flex justify-end gap-2">
			<button type="button" class="btn" onclick={() => (editOpen = false)}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={busy || !name.trim()}>
				{editTarget ? 'Save' : 'Create'}
			</button>
		</div>
	</form>
</Modal>

<Modal bind:open={memberOpen} title={`Members of ${memberTarget?.name ?? 'group'}`} wide>
	<div class="space-y-4">
		<Field label="Services">
			<div class="flex flex-wrap gap-1.5">
				{#each services as s (s.id)}
					<button
						type="button"
						class="chip cursor-pointer py-1 {selServices.includes(s.id) ? 'chip-on' : ''}"
						aria-pressed={selServices.includes(s.id)}
						onclick={() => {
							selServices = toggle(selServices, s.id);
						}}
					>
						{s.name}
					</button>
				{:else}
					<span class="text-xs text-faint">No services configured</span>
				{/each}
			</div>
		</Field>
		<Field label="Apps" hint="Deploy applications">
			<div class="flex flex-wrap gap-1.5">
				{#each apps as a (a.id)}
					<button
						type="button"
						class="chip cursor-pointer py-1 {selApps.includes(a.id) ? 'chip-on' : ''}"
						aria-pressed={selApps.includes(a.id)}
						onclick={() => {
							selApps = toggle(selApps, a.id);
						}}
					>
						{a.name}
					</button>
				{:else}
					<span class="text-xs text-faint">No deploy apps</span>
				{/each}
			</div>
		</Field>
		<div class="flex justify-end gap-2">
			<button type="button" class="btn" onclick={() => (memberOpen = false)}>Cancel</button>
			<button
				type="button"
				class="btn btn-primary"
				disabled={busy}
				onclick={() => void saveMembers()}
			>
				Save members
			</button>
		</div>
	</div>
</Modal>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Delete group?"
	description={`"${deleteTarget?.name ?? 'This group'}" and its memberships will be removed.`}
	confirmLabel="Delete"
	danger
	onconfirm={() => void remove()}
/>
