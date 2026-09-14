<script lang="ts">
	import { onMount } from 'svelte';
	import { FolderGit2, Pencil, Plus, Trash, Users, UsersRound } from '@lucide/svelte';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import Modal from '$lib/components/admin/Modal.svelte';
	import ConfirmDialog from '$lib/components/admin/ConfirmDialog.svelte';
	import ChatAvatar from '$lib/components/admin/ChatAvatar.svelte';
	import { api, ApiError, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import type { GroupRef, TeamInfo, TeamMember } from '$lib/shared/groups';

	let teams = $state<TeamInfo[]>([]);
	let users = $state<TeamMember[]>([]);
	let groups = $state<GroupRef[]>([]);
	let loading = $state(true);
	let busy = $state(false);

	let editTarget = $state<TeamInfo | null>(null);
	let editOpen = $state(false);
	let name = $state('');

	let memberTarget = $state<TeamInfo | null>(null);
	let memberOpen = $state(false);
	let selUsers = $state<number[]>([]);

	let groupTarget = $state<TeamInfo | null>(null);
	let groupOpen = $state(false);
	let selGroups = $state<string[]>([]);

	let deleteTarget = $state<TeamInfo | null>(null);
	let deleteOpen = $state(false);

	async function load(): Promise<void> {
		try {
			const [t, g] = await Promise.all([
				api<{ teams: TeamInfo[]; users: TeamMember[] }>('/teams'),
				api<{ groups: GroupRef[] }>('/groups').catch(() => ({ groups: [] as GroupRef[] }))
			]);
			teams = t.teams;
			users = t.users;
			groups = g.groups;
		} catch (err) {
			toast('error', errMessage(err, 'load failed'));
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function openEdit(t: TeamInfo | null): void {
		editTarget = t;
		name = t?.name ?? '';
		editOpen = true;
	}

	function openMembers(t: TeamInfo): void {
		memberTarget = t;
		selUsers = t.members.map((m) => m.id);
		memberOpen = true;
	}

	function openGroups(t: TeamInfo): void {
		groupTarget = t;
		selGroups = t.groups.map((g) => g.id);
		groupOpen = true;
	}

	function memberName(m: TeamMember): string {
		return m.displayName || m.username;
	}

	async function save(): Promise<void> {
		busy = true;
		try {
			if (editTarget) {
				await api(`/teams/${editTarget.id}`, { method: 'PATCH', body: { name: name.trim() } });
				toast('success', 'Team updated');
			} else {
				await api('/teams', { body: { name: name.trim() } });
				toast('success', 'Team created');
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
			const before = memberTarget.members.map((m) => m.id);
			const add = selUsers.filter((u) => !before.includes(u));
			const remove = before.filter((u) => !selUsers.includes(u));
			await api(`/teams/${memberTarget.id}/members`, { method: 'PUT', body: { add, remove } });
			toast('success', 'Members updated');
			memberOpen = false;
			await load();
		} catch (err) {
			toast('error', errMessage(err, 'member save failed'));
		} finally {
			busy = false;
		}
	}

	async function saveGroups(): Promise<void> {
		if (!groupTarget) return;
		busy = true;
		try {
			await api(`/teams/${groupTarget.id}/groups`, {
				method: 'PUT',
				body: { groupIds: selGroups }
			});
			toast('success', 'Group assignments updated');
			groupOpen = false;
			await load();
		} catch (err) {
			toast('error', errMessage(err, 'group save failed'));
		} finally {
			busy = false;
		}
	}

	async function remove(): Promise<void> {
		if (!deleteTarget) return;
		busy = true;
		try {
			await api(`/teams/${deleteTarget.id}`, { method: 'DELETE' });
			toast('success', 'Team deleted');
			deleteOpen = false;
			await load();
		} catch (err) {
			toast('error', errMessage(err, 'delete failed'));
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader title="Teams" description="Group panel users and scope them to service groups">
	<button
		class="btn btn-primary"
		onclick={() => {
			openEdit(null);
		}}
	>
		<Plus class="size-4" /> New team
	</button>
</PageHeader>

{#if loading}
	<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
		{#each [0, 1, 2] as i (i)}
			<div class="card h-28 animate-pulse"></div>
		{/each}
	</div>
{:else if teams.length === 0}
	<div class="card p-10 text-center">
		<UsersRound class="mx-auto mb-3 size-8 text-faint" />
		<p class="text-muted">No teams yet.</p>
		<p class="mt-1 text-xs text-faint">
			Teams group panel users and assign them service groups for scoped dashboards.
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
		{#each teams as t (t.id)}
			<div class="card p-4">
				<div class="flex items-center justify-between gap-2">
					<span class="truncate text-sm font-semibold">{t.name}</span>
					<span class="chip chip-muted">{t.members.length}</span>
				</div>
				<div class="mt-3 flex items-center">
					<div class="flex -space-x-2">
						{#each t.members.slice(0, 6) as m (m.id)}
							<span title={memberName(m)}>
								<ChatAvatar
									userId={m.id}
									name={memberName(m)}
									hasAvatar={m.hasAvatar}
									size="size-7"
								/>
							</span>
						{/each}
					</div>
					{#if t.members.length > 6}
						<span class="ml-2 text-xs text-faint">+{t.members.length - 6}</span>
					{/if}
					{#if t.members.length === 0}
						<span class="text-xs text-faint">No members</span>
					{/if}
				</div>
				<div class="mt-2 flex flex-wrap gap-1">
					{#each t.groups as g (g.id)}
						<span class="chip flex items-center gap-1.5">
							{#if g.color}
								<span
									class="size-2 rounded-full"
									style="background-color: {g.color}"
									aria-hidden="true"
								></span>
							{/if}
							{g.name}
						</span>
					{:else}
						<span class="text-xs text-faint">No groups assigned</span>
					{/each}
				</div>
				<div class="mt-3 flex gap-1 border-t border-edge pt-3">
					<button
						class="btn btn-ghost btn-sm"
						onclick={() => {
							openMembers(t);
						}}
					>
						<Users class="size-3.5" /> Members
					</button>
					<button
						class="btn btn-ghost btn-sm"
						onclick={() => {
							openGroups(t);
						}}
					>
						<FolderGit2 class="size-3.5" /> Groups
					</button>
					<button
						class="btn btn-ghost btn-sm"
						onclick={() => {
							openEdit(t);
						}}
					>
						<Pencil class="size-3.5" />
					</button>
					<button
						class="btn btn-ghost btn-sm ml-auto text-down-fg"
						aria-label="Delete {t.name}"
						onclick={() => {
							deleteTarget = t;
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

<Modal bind:open={editOpen} title={editTarget ? `Edit ${editTarget.name}` : 'New team'}>
	<form
		class="space-y-4"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<Field label="Name" required>
			<input class="input" bind:value={name} placeholder="on-call" required maxlength="64" />
		</Field>
		<div class="flex justify-end gap-2">
			<button type="button" class="btn" onclick={() => (editOpen = false)}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={busy || !name.trim()}>
				{editTarget ? 'Save' : 'Create'}
			</button>
		</div>
	</form>
</Modal>

<Modal bind:open={memberOpen} title={`Members of ${memberTarget?.name ?? 'team'}`}>
	<div class="space-y-4">
		<div class="max-h-72 space-y-1 overflow-y-auto">
			{#each users as u (u.id)}
				<label
					class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-panel"
				>
					<input
						type="checkbox"
						checked={selUsers.includes(u.id)}
						onchange={() => {
							selUsers = selUsers.includes(u.id)
								? selUsers.filter((x) => x !== u.id)
								: [...selUsers, u.id];
						}}
					/>
					<ChatAvatar userId={u.id} name={memberName(u)} hasAvatar={u.hasAvatar} size="size-7" />
					<span class="min-w-0 flex-1 truncate text-sm">{memberName(u)}</span>
					<span class="text-xs text-faint">@{u.username}</span>
				</label>
			{:else}
				<p class="text-xs text-faint">No users</p>
			{/each}
		</div>
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

<Modal bind:open={groupOpen} title={`Groups for ${groupTarget?.name ?? 'team'}`}>
	<div class="space-y-4">
		<div class="max-h-72 space-y-1 overflow-y-auto">
			{#each groups as g (g.id)}
				<label
					class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-panel"
				>
					<input
						type="checkbox"
						checked={selGroups.includes(g.id)}
						onchange={() => {
							selGroups = selGroups.includes(g.id)
								? selGroups.filter((x) => x !== g.id)
								: [...selGroups, g.id];
						}}
					/>
					{#if g.color}
						<span
							class="size-2.5 shrink-0 rounded-full"
							style="background-color: {g.color}"
							aria-hidden="true"
						></span>
					{/if}
					<span class="min-w-0 flex-1 truncate text-sm">{g.name}</span>
				</label>
			{:else}
				<p class="text-xs text-faint">No service groups defined</p>
			{/each}
		</div>
		<div class="flex justify-end gap-2">
			<button type="button" class="btn" onclick={() => (groupOpen = false)}>Cancel</button>
			<button
				type="button"
				class="btn btn-primary"
				disabled={busy}
				onclick={() => void saveGroups()}
			>
				Save groups
			</button>
		</div>
	</div>
</Modal>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Delete team?"
	description={`"${deleteTarget?.name ?? 'This team'}" will be removed; member accounts are unaffected.`}
	confirmLabel="Delete"
	danger
	onconfirm={() => void remove()}
/>
