<script lang="ts">
	import { Pencil, Plus, Trash } from '@lucide/svelte';
	import Modal from './Modal.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import Field from './Field.svelte';
	import PermPicker from './PermPicker.svelte';
	import { api, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import type { RoleInfo } from '$lib/shared/auth';

	// Roles panel: compact rows with a modal permission editor instead
	// of an inline checkbox grid per role. The parent owns the data and
	// refetches via onchanged after every mutation.
	const {
		roles,
		allPerms,
		onchanged
	}: {
		roles: RoleInfo[];
		allPerms: string[];
		onchanged: () => void | Promise<void>;
	} = $props();

	let busy = $state(false);

	// edit modal
	let editOpen = $state(false);
	let editTarget = $state<RoleInfo | null>(null);
	let editLabel = $state('');
	let editPerms = $state<string[]>([]);

	// create modal
	let createOpen = $state(false);
	let nName = $state('');
	let nLabel = $state('');
	let nPerms = $state<string[]>([]);

	// delete confirm
	let deleteTarget = $state<RoleInfo | null>(null);
	let deleteOpen = $state(false);

	function openEdit(r: RoleInfo): void {
		editTarget = r;
		editLabel = r.label;
		editPerms = [...r.permissions];
		editOpen = true;
	}

	async function saveEdit(): Promise<void> {
		if (!editTarget || busy) return;
		busy = true;
		try {
			await api(`/roles/${encodeURIComponent(editTarget.name)}`, {
				method: 'PATCH',
				body: { label: editLabel.trim(), permissions: editPerms }
			});
			toast('success', `Role ${editTarget.name} saved`);
			editOpen = false;
			editTarget = null;
			await onchanged();
		} catch (err) {
			toast('error', errMessage(err, 'save failed'));
		} finally {
			busy = false;
		}
	}

	async function createRole(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			await api('/roles', {
				body: { name: nName.trim(), label: nLabel.trim(), permissions: nPerms }
			});
			toast('success', `Role ${nName.trim()} created`);
			createOpen = false;
			nName = '';
			nLabel = '';
			nPerms = [];
			await onchanged();
		} catch (err) {
			toast('error', errMessage(err, 'create failed'));
		} finally {
			busy = false;
		}
	}

	async function removeRole(): Promise<void> {
		if (!deleteTarget || busy) return;
		busy = true;
		try {
			await api(`/roles/${encodeURIComponent(deleteTarget.name)}`, { method: 'DELETE' });
			toast('success', `Role ${deleteTarget.name} deleted`);
			deleteTarget = null;
			deleteOpen = false;
			await onchanged();
		} catch (err) {
			toast('error', errMessage(err, 'delete failed'));
		} finally {
			busy = false;
		}
	}
</script>

<section class="mt-8">
	<div class="mb-3 flex items-center justify-between gap-3">
		<div>
			<h2 class="text-sm font-semibold">Roles</h2>
			<p class="mt-0.5 text-xs text-faint">
				Permission sets applied to accounts. The admin role always holds every permission.
			</p>
		</div>
		<button class="btn btn-sm shrink-0" onclick={() => (createOpen = true)}>
			<Plus class="size-3.5" /> New role
		</button>
	</div>

	<div class="card divide-y divide-edge">
		{#each roles as r (r.name)}
			<div class="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3">
				<span class="text-sm font-medium">{r.label || r.name}</span>
				<span class="font-mono text-xs text-faint">{r.name}</span>
				{#if r.builtin}<span class="chip">built-in</span>{/if}
				<span class="chip">{r.members} {r.members === 1 ? 'user' : 'users'}</span>
				<span class="text-xs text-faint">
					{r.name === 'admin' ? 'all permissions' : `${r.permissions.length} permissions`}
				</span>
				<span class="ml-auto flex items-center gap-1">
					{#if r.name !== 'admin'}
						<button
							class="btn btn-ghost btn-sm"
							disabled={busy}
							onclick={() => {
								openEdit(r);
							}}
						>
							<Pencil class="size-3.5" /> Edit
						</button>
					{/if}
					{#if !r.builtin}
						<button
							class="btn btn-ghost btn-sm text-down-fg"
							disabled={r.members > 0 || busy}
							title={r.members > 0 ? 'Still assigned to users' : 'Delete role'}
							onclick={() => {
								deleteTarget = r;
								deleteOpen = true;
							}}
						>
							<Trash class="size-3.5" />
						</button>
					{/if}
				</span>
			</div>
		{:else}
			<p class="px-4 py-3 text-xs text-faint">No roles defined.</p>
		{/each}
	</div>
</section>

<!-- Edit role -->
<Modal bind:open={editOpen} title="Edit role{editTarget ? ` ${editTarget.name}` : ''}" wide>
	{#if editTarget}
		<form
			class="space-y-4"
			onsubmit={(e) => {
				e.preventDefault();
				void saveEdit();
			}}
		>
			<Field label="Label" hint="Shown in the panel. The name is fixed.">
				<input class="input" bind:value={editLabel} />
			</Field>
			<Field label="Permissions" hint="Click a group name to toggle the whole group.">
				<PermPicker permissions={allPerms} bind:selected={editPerms} />
			</Field>
			<div class="flex justify-end gap-2">
				<button type="button" class="btn" onclick={() => (editOpen = false)}>Cancel</button>
				<button type="submit" class="btn btn-primary" disabled={busy}>Save role</button>
			</div>
		</form>
	{/if}
</Modal>

<!-- New role -->
<Modal bind:open={createOpen} title="New role" wide>
	<form
		class="space-y-4"
		onsubmit={(e) => {
			e.preventDefault();
			void createRole();
		}}
	>
		<div class="grid gap-3 sm:grid-cols-2">
			<Field label="Name" required hint="Lowercase identifier used in the API.">
				<input class="input font-mono" bind:value={nName} required />
			</Field>
			<Field label="Label" hint="Shown in the panel. Defaults to the name.">
				<input class="input" bind:value={nLabel} />
			</Field>
		</div>
		<Field label="Permissions" hint="Click a group name to toggle the whole group.">
			<PermPicker permissions={allPerms} bind:selected={nPerms} />
		</Field>
		<div class="flex justify-end gap-2">
			<button type="button" class="btn" onclick={() => (createOpen = false)}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={busy || !nName.trim()}>
				Create role
			</button>
		</div>
	</form>
</Modal>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Delete role?"
	description={`${deleteTarget?.name ?? 'This role'} will be removed.`}
	confirmLabel="Delete"
	danger
	onconfirm={() => void removeRole()}
/>
