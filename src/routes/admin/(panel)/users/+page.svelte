<script lang="ts">
	import { onMount } from 'svelte';
	import { Check, Copy, KeyRound, Link2, MonitorSmartphone, Trash, UserPlus } from '@lucide/svelte';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import PasswordStrength from '$lib/components/admin/PasswordStrength.svelte';
	import Modal from '$lib/components/admin/Modal.svelte';
	import ConfirmDialog from '$lib/components/admin/ConfirmDialog.svelte';
	import SessionList from '$lib/components/admin/SessionList.svelte';
	import { api, ApiError } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import { relativeTime } from '$lib/utils/format';
	import { generatePassword } from '$lib/shared/password';
	import type { PublicUser as User, Role } from '$lib/shared/auth';

	interface Invite {
		hash: string;
		kind: string;
		role: Role;
		createdAt: number;
		expiresAt: number;
		usedAt: number | null;
		revokedAt: number | null;
		expired: boolean;
	}

	interface RoleRow {
		name: string;
		label: string;
		permissions: string[];
		builtin: boolean;
		createdAt: number;
		members: number;
	}

	const { data }: { data: { user: User; perms: string[] } } = $props();

	const canUsers = $derived(data.perms.includes('users.manage'));
	const canInvites = $derived(data.perms.includes('invites.manage'));
	const canRoles = $derived(data.perms.includes('roles.manage'));
	const canKeys = $derived(data.perms.includes('admin.settings'));

	let users = $state<User[]>([]);
	let invites = $state<Invite[]>([]);
	let roles = $state<RoleRow[]>([]);
	let allPerms = $state<string[]>([]);
	let loading = $state(true);
	let busy = $state(false);

	// roles editor
	let roleBusy = $state(false);
	let nRoleName = $state('');
	let nRoleLabel = $state('');
	let nRolePerms = $state<string[]>([]);
	let roleDeleteTarget = $state<RoleRow | null>(null);
	let roleDeleteOpen = $state(false);

	// invite dialog
	let inviteOpen = $state(false);
	let inviteRole = $state<Role>('operator');
	let inviteTtl = $state(24);
	let inviteUrl = $state<string | null>(null);
	let copied = $state(false);

	// create user dialog
	let createOpen = $state(false);
	let cUsername = $state('');
	let cDisplay = $state('');
	let cPassword = $state('');
	let cRole = $state<Role>('operator');

	// reset password dialog
	let resetTarget = $state<User | null>(null);
	let resetOpen = $state(false);
	let resetPassword = $state('');

	// delete
	let deleteTarget = $state<User | null>(null);
	let deleteOpen = $state(false);

	// per-user sessions
	interface SessionRow {
		hash: string;
		createdAt: number;
		expiresAt: number;
		lastSeenAt: number;
		ip: string | null;
		userAgent: string | null;
		current: boolean;
	}
	let sessTarget = $state<User | null>(null);
	let sessOpen = $state(false);
	let sessList = $state<SessionRow[]>([]);
	let sessBusy = $state(false);
	let sessRevokeTarget = $state<SessionRow | null>(null);
	let sessRevokeOpen = $state(false);
	let sessRevokeAllOpen = $state(false);

	// api keys
	interface ApiKeyRow {
		id: number;
		name: string;
		scopes: string[];
		createdBy: string | null;
		createdAt: number;
		lastUsed: number | null;
		disabledAt: number | null;
	}
	let keys = $state<ApiKeyRow[]>([]);
	let keyName = $state('');
	let keyRead = $state(true);
	let keyWrite = $state(false);
	let keyToken = $state<string | null>(null);
	let keyModalOpen = $state(false);
	let keyBusy = $state(false);

	const pending = $derived(
		invites.filter((i) => !i.usedAt && !i.revokedAt && !i.expired && i.kind === 'invite')
	);

	// Select options come from the roles API when visible; otherwise fall
	// back to the seeded builtins plus whatever roles users already hold.
	const roleOptions = $derived(
		roles.length > 0
			? roles.map((r) => r.name)
			: [...new Set(['admin', 'operator', ...users.map((u) => u.role)])]
	);

	async function load(): Promise<void> {
		try {
			const [u, i, k, r] = await Promise.all([
				canUsers ? api<{ users: User[] }>('/users') : Promise.resolve({ users: [] }),
				canInvites ? api<{ invites: Invite[] }>('/invites') : Promise.resolve({ invites: [] }),
				canKeys
					? api<{ keys: ApiKeyRow[] }>('/keys').catch(() => ({ keys: [] }))
					: Promise.resolve({ keys: [] }),
				canRoles
					? api<{ roles: RoleRow[]; permissions: string[] }>('/roles').catch(() => ({
							roles: [],
							permissions: []
						}))
					: Promise.resolve({ roles: [], permissions: [] })
			]);
			users = u.users;
			invites = i.invites;
			keys = k.keys;
			roles = r.roles;
			allPerms = r.permissions;
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'load failed');
		} finally {
			loading = false;
		}
	}

	onMount(load);

	async function copy(text: string): Promise<void> {
		await navigator.clipboard.writeText(text);
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}

	async function makeInvite(): Promise<void> {
		busy = true;
		try {
			const r = await api<{ url: string }>('/invites', {
				body: { role: inviteRole, ttl_hours: inviteTtl }
			});
			inviteUrl = r.url;
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'invite failed');
		} finally {
			busy = false;
		}
	}

	async function revokeInvite(i: Invite): Promise<void> {
		try {
			await api(`/invites/${i.hash}`, { method: 'DELETE' });
			toast('success', 'Invite revoked');
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'revoke failed');
		}
	}

	async function createUser(): Promise<void> {
		busy = true;
		try {
			await api('/users', {
				body: {
					username: cUsername,
					display_name: cDisplay,
					password: cPassword,
					role: cRole
				}
			});
			toast('success', `User ${cUsername} created`);
			createOpen = false;
			cUsername = '';
			cDisplay = '';
			cPassword = '';
			cRole = 'operator';
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'create failed');
		} finally {
			busy = false;
		}
	}

	async function setRole(u: User, role: Role): Promise<void> {
		try {
			await api(`/users/${u.id}`, { method: 'PATCH', body: { role } });
			toast('success', `${u.username} is now ${role}`);
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'update failed');
		}
	}

	async function setDisabled(u: User, disabled: boolean): Promise<void> {
		try {
			await api(`/users/${u.id}`, { method: 'PATCH', body: { disabled } });
			toast('success', `${u.username} ${disabled ? 'disabled' : 'enabled'}`);
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'update failed');
		}
	}

	async function resetPw(): Promise<void> {
		if (!resetTarget) return;
		busy = true;
		try {
			await api(`/users/${resetTarget.id}/reset`, { body: { password: resetPassword } });
			toast('success', `Password reset for ${resetTarget.username}`);
			resetTarget = null;
			resetOpen = false;
			resetPassword = '';
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'reset failed');
		} finally {
			busy = false;
		}
	}

	async function createKey(): Promise<void> {
		const scopes = [keyRead ? 'read' : '', keyWrite ? 'write' : ''].filter(Boolean);
		if (!keyName.trim() || scopes.length === 0 || keyBusy) return;
		keyBusy = true;
		try {
			const r = await api<{ token: string }>('/keys', {
				body: { name: keyName.trim(), scopes }
			});
			keyToken = r.token;
			keyModalOpen = true;
			keyName = '';
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'create failed');
		} finally {
			keyBusy = false;
		}
	}

	async function toggleKey(k: ApiKeyRow): Promise<void> {
		try {
			await api('/keys', {
				method: 'PATCH',
				body: { id: k.id, disabled: k.disabledAt === null }
			});
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'update failed');
		}
	}

	async function removeKey(k: ApiKeyRow): Promise<void> {
		try {
			await api(`/keys?id=${k.id}`, { method: 'DELETE' });
			toast('success', `Key ${k.name} deleted`);
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'delete failed');
		}
	}

	async function loadSessions(): Promise<void> {
		if (!sessTarget) return;
		sessBusy = true;
		try {
			const r = await api<{ sessions: SessionRow[] }>(`/users/${sessTarget.id}/sessions`);
			sessList = r.sessions;
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'load failed');
		} finally {
			sessBusy = false;
		}
	}

	async function openSessions(u: User): Promise<void> {
		sessTarget = u;
		sessList = [];
		sessOpen = true;
		await loadSessions();
	}

	async function revokeUserSession(): Promise<void> {
		if (!sessTarget || !sessRevokeTarget) return;
		try {
			await api(`/users/${sessTarget.id}/sessions/${sessRevokeTarget.hash}`, {
				method: 'DELETE'
			});
			toast('success', 'Session revoked');
			sessRevokeTarget = null;
			sessRevokeOpen = false;
			await loadSessions();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'revoke failed');
		}
	}

	async function revokeAllUserSessions(): Promise<void> {
		if (!sessTarget) return;
		try {
			await api(`/users/${sessTarget.id}/sessions`, { method: 'DELETE' });
			toast('success', `Sessions revoked for ${sessTarget.username}`);
			sessRevokeAllOpen = false;
			await loadSessions();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'revoke failed');
		}
	}

	async function removeUser(): Promise<void> {
		if (!deleteTarget) return;
		try {
			await api(`/users/${deleteTarget.id}`, { method: 'DELETE' });
			toast('success', `${deleteTarget.username} deleted`);
			deleteTarget = null;
			deleteOpen = false;
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'delete failed');
		}
	}

	async function saveRole(r: RoleRow): Promise<void> {
		try {
			await api(`/roles/${encodeURIComponent(r.name)}`, {
				method: 'PATCH',
				body: { label: r.label, permissions: r.permissions }
			});
			toast('success', `Role ${r.name} saved`);
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'save failed');
		}
	}

	async function createRole(): Promise<void> {
		if (roleBusy) return;
		roleBusy = true;
		try {
			await api('/roles', {
				body: { name: nRoleName.trim(), label: nRoleLabel.trim(), permissions: nRolePerms }
			});
			toast('success', `Role ${nRoleName.trim()} created`);
			nRoleName = '';
			nRoleLabel = '';
			nRolePerms = [];
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'create failed');
		} finally {
			roleBusy = false;
		}
	}

	async function removeRole(): Promise<void> {
		if (!roleDeleteTarget) return;
		try {
			await api(`/roles/${encodeURIComponent(roleDeleteTarget.name)}`, { method: 'DELETE' });
			toast('success', `Role ${roleDeleteTarget.name} deleted`);
			roleDeleteTarget = null;
			roleDeleteOpen = false;
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'delete failed');
		}
	}
</script>

<PageHeader title="Users" description="Accounts and invite links">
	{#if canInvites}
		<button class="btn" onclick={() => (inviteOpen = true)}
			><Link2 class="size-4" /> Invite link</button
		>
	{/if}
	{#if canUsers}
		<button class="btn btn-primary" onclick={() => (createOpen = true)}>
			<UserPlus class="size-4" /> Create user
		</button>
	{/if}
</PageHeader>

{#if loading}
	<div class="space-y-6">
		<div class="card h-48 animate-pulse"></div>
		<div class="card h-32 animate-pulse"></div>
	</div>
{:else}
	<div class="card divide-y divide-edge">
		{#each users as u (u.id)}
			<div class="flex items-center gap-3 px-4 py-3">
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-2">
						<span class="text-sm font-medium">{u.username}</span>
						{#if u.displayName}<span class="text-xs text-muted">({u.displayName})</span>{/if}
						{#if u.id === data.user.id}<span class="chip chip-on">you</span>{/if}
						{#if u.totpEnabled}<span class="chip" title="TOTP enabled">2FA</span>{/if}
						{#if u.disabledAt !== null}<span class="chip border-down/50 text-down-fg">disabled</span
							>{/if}
					</div>
					<p class="mt-0.5 text-xs text-faint">
						{u.lastLoginAt ? `last login ${relativeTime(u.lastLoginAt)}` : 'never logged in'}
					</p>
				</div>
				<div class="flex shrink-0 items-center gap-1">
					<select
						class="input w-auto py-1 text-xs"
						value={u.role}
						disabled={u.id === data.user.id || !canUsers}
						onchange={(e) => setRole(u, e.currentTarget.value)}
						aria-label="Role"
					>
						{#each roleOptions as r (r)}
							<option value={r}>{r}</option>
						{/each}
					</select>
					{#if canUsers}
						<button
							class="btn btn-ghost btn-sm"
							title="Sessions"
							onclick={() => void openSessions(u)}
						>
							<MonitorSmartphone class="size-3.5" />
						</button>
						<button
							class="btn btn-ghost btn-sm"
							title="Reset password"
							onclick={() => {
								resetTarget = u;
								resetPassword = '';
								resetOpen = true;
							}}
						>
							<KeyRound class="size-3.5" />
						</button>
						{#if u.disabledAt === null}
							<button
								class="btn btn-ghost btn-sm"
								title="Disable account"
								disabled={u.id === data.user.id}
								onclick={() => setDisabled(u, true)}
							>
								<Check class="size-3.5 opacity-40" />
							</button>
						{:else}
							<button
								class="btn btn-ghost btn-sm text-up-fg"
								title="Enable account"
								onclick={() => setDisabled(u, false)}
							>
								<Check class="size-3.5" />
							</button>
						{/if}
						<button
							class="btn btn-ghost btn-sm text-down-fg"
							title="Delete"
							disabled={u.id === data.user.id}
							onclick={() => {
								deleteTarget = u;
								deleteOpen = true;
							}}
						>
							<Trash class="size-3.5" />
						</button>
					{/if}
				</div>
			</div>
		{/each}
	</div>

	{#if canInvites && pending.length > 0}
		<section class="mt-8">
			<h2 class="mb-3 text-sm font-semibold">Pending invites</h2>
			<div class="card divide-y divide-edge">
				{#each pending as i (i.hash)}
					<div class="flex items-center justify-between gap-3 px-4 py-3 text-sm">
						<span class="text-muted">
							{i.role} · created {relativeTime(i.createdAt)} · expires {relativeTime(i.expiresAt)}
						</span>
						<button class="btn btn-ghost btn-sm text-down-fg" onclick={() => revokeInvite(i)}>
							Revoke
						</button>
					</div>
				{/each}
			</div>
		</section>
	{/if}

	{#if canRoles}
		<section class="mt-8">
			<h2 class="mb-1 text-sm font-semibold">Roles</h2>
			<p class="mb-3 text-xs text-faint">
				Permission sets applied to accounts. The admin role always holds every permission and cannot
				be edited or deleted.
			</p>
			<div class="card divide-y divide-edge">
				{#each roles as r (r.name)}
					<div class="px-4 py-3">
						<div class="flex flex-wrap items-center gap-2">
							{#if r.builtin}
								<span class="text-sm font-medium">{r.label}</span>
							{:else}
								<input class="input w-40 py-1 text-xs" bind:value={r.label} aria-label="Label" />
							{/if}
							<span class="font-mono text-xs text-faint">{r.name}</span>
							{#if r.builtin}<span class="chip">built-in</span>{/if}
							<span class="chip">{r.members} {r.members === 1 ? 'user' : 'users'}</span>
							<span class="ml-auto flex items-center gap-1">
								{#if r.name !== 'admin'}
									<button
										class="btn btn-ghost btn-sm"
										disabled={roleBusy}
										onclick={() => void saveRole(r)}
									>
										Save
									</button>
								{/if}
								{#if !r.builtin}
									<button
										class="btn btn-ghost btn-sm text-down-fg"
										disabled={r.members > 0}
										title={r.members > 0 ? 'still assigned to users' : 'Delete role'}
										onclick={() => {
											roleDeleteTarget = r;
											roleDeleteOpen = true;
										}}
									>
										Delete
									</button>
								{/if}
							</span>
						</div>
						<div class="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
							{#each allPerms as p (p)}
								<label class="flex items-center gap-1.5 text-xs text-muted">
									<input
										type="checkbox"
										bind:group={r.permissions}
										value={p}
										disabled={r.name === 'admin'}
									/>
									{p}
								</label>
							{/each}
						</div>
					</div>
				{/each}
				<form
					class="px-4 py-3"
					onsubmit={(e) => {
						e.preventDefault();
						void createRole();
					}}
				>
					<div class="flex flex-wrap items-center gap-2">
						<input
							class="input w-40 text-xs"
							placeholder="role name"
							bind:value={nRoleName}
							required
						/>
						<input class="input w-40 text-xs" placeholder="label" bind:value={nRoleLabel} />
						<button class="btn btn-sm" type="submit" disabled={roleBusy || !nRoleName.trim()}>
							Create role
						</button>
					</div>
					<div class="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
						{#each allPerms as p (p)}
							<label class="flex items-center gap-1.5 text-xs text-muted">
								<input type="checkbox" bind:group={nRolePerms} value={p} />
								{p}
							</label>
						{/each}
					</div>
				</form>
			</div>
		</section>
	{/if}

	{#if canKeys}
		<section class="mt-8">
			<h2 class="mb-1 text-sm font-semibold">Automation API keys</h2>
			<p class="mb-3 text-xs text-faint">
				Bearer keys for <code class="font-mono">/api/v1/*</code> (status, incidents, markers). The token
				is shown once.
			</p>
			<div class="card divide-y divide-edge">
				{#each keys as k (k.id)}
					<div class="flex items-center justify-between gap-3 px-4 py-3 text-sm">
						<div class="min-w-0">
							<span class="font-medium">{k.name}</span>
							<span class="ml-2 text-xs text-faint">
								{k.scopes.join('+')} · by {k.createdBy ?? 'unknown'} · {k.lastUsed
									? `used ${relativeTime(k.lastUsed)}`
									: 'never used'}
							</span>
						</div>
						<div class="flex shrink-0 items-center gap-2">
							{#if k.disabledAt !== null}<span class="chip border-down/50 text-down-fg"
									>disabled</span
								>{/if}
							<button class="btn btn-ghost btn-sm" onclick={() => toggleKey(k)}>
								{k.disabledAt === null ? 'Disable' : 'Enable'}
							</button>
							<button class="btn btn-ghost btn-sm text-down-fg" onclick={() => void removeKey(k)}>
								Delete
							</button>
						</div>
					</div>
				{:else}
					<p class="px-4 py-3 text-xs text-faint">No keys yet.</p>
				{/each}
				<form
					class="flex flex-wrap items-center gap-2 px-4 py-3"
					onsubmit={(e) => {
						e.preventDefault();
						void createKey();
					}}
				>
					<input
						class="input w-48 text-xs"
						placeholder="key name (e.g. ci-deploy)"
						bind:value={keyName}
					/>
					<label class="flex items-center gap-1 text-xs text-muted">
						<input type="checkbox" bind:checked={keyRead} /> read
					</label>
					<label class="flex items-center gap-1 text-xs text-muted">
						<input type="checkbox" bind:checked={keyWrite} /> write
					</label>
					<button
						class="btn btn-sm"
						type="submit"
						disabled={keyBusy || !keyName.trim() || (!keyRead && !keyWrite)}
					>
						Create key
					</button>
				</form>
			</div>
		</section>
	{/if}
{/if}

<!-- Invite dialog -->
<Modal bind:open={inviteOpen} title="Create invite link">
	<div class="space-y-4">
		{#if inviteUrl === null}
			<p class="text-sm text-muted">
				The link works once, for one account, and expires automatically. Send it over a private
				channel.
			</p>
			<div class="grid grid-cols-2 gap-3">
				<Field label="Role" required>
					<select class="input" bind:value={inviteRole}>
						{#each roleOptions as r (r)}
							<option value={r}>{r}</option>
						{/each}
					</select>
				</Field>
				<Field label="Lifetime (hours)">
					<input class="input" type="number" min="1" max="720" bind:value={inviteTtl} />
				</Field>
			</div>
			<div class="flex justify-end gap-2">
				<button class="btn" onclick={() => (inviteOpen = false)}>Cancel</button>
				<button class="btn btn-primary" disabled={busy} onclick={makeInvite}>Generate</button>
			</div>
		{:else}
			<p class="text-sm text-muted">
				Share this link. It is shown once; a new one can be generated anytime.
			</p>
			<div class="flex gap-2">
				<input class="input flex-1 font-mono text-xs" readonly value={inviteUrl} />
				<button class="btn" title="Copy" onclick={() => copy(inviteUrl ?? '')}>
					{#if copied}<Check class="size-4 text-up-fg" />{:else}<Copy class="size-4" />{/if}
				</button>
			</div>
			<div class="flex justify-end">
				<button
					class="btn btn-primary"
					onclick={() => {
						inviteUrl = null;
						inviteOpen = false;
					}}
				>
					Done
				</button>
			</div>
		{/if}
	</div>
</Modal>

<!-- Create user -->
<Modal bind:open={createOpen} title="Create user">
	<form
		class="space-y-4"
		onsubmit={(e) => {
			e.preventDefault();
			void createUser();
		}}
	>
		<Field label="Username" required hint="a-z, 0-9, dot, dash, underscore.">
			<input class="input" bind:value={cUsername} required autocomplete="off" />
		</Field>
		<Field label="Display name">
			<input class="input" bind:value={cDisplay} />
		</Field>
		<Field label="Temporary password" required hint="They can change it in Account settings.">
			<input
				class="input"
				type="password"
				bind:value={cPassword}
				required
				autocomplete="new-password"
			/>
			<PasswordStrength password={cPassword} username={cUsername} />
			<button
				type="button"
				class="mt-1.5 text-[11px] text-accent hover:underline"
				onclick={() => {
					cPassword = generatePassword();
					void (navigator.clipboard as Clipboard | undefined)?.writeText(cPassword).then(() => {
						toast('success', 'Generated and copied to clipboard');
					});
				}}
			>
				Generate a strong password
			</button>
		</Field>
		<Field label="Role" required>
			<select class="input" bind:value={cRole}>
				{#each roleOptions as r (r)}
					<option value={r}>{r}</option>
				{/each}
			</select>
		</Field>
		<div class="flex justify-end gap-2">
			<button type="button" class="btn" onclick={() => (createOpen = false)}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={busy}>Create</button>
		</div>
	</form>
</Modal>

<!-- Reset password -->
<Modal bind:open={resetOpen} title="Reset password">
	<form
		class="space-y-4"
		onsubmit={(e) => {
			e.preventDefault();
			void resetPw();
		}}
	>
		<p class="text-sm text-muted">
			Set a new password for <span class="font-medium text-fg">{resetTarget?.username}</span>. Their
			sessions stay active; ask them to sign out and back in.
		</p>
		<Field label="New password" required>
			<input
				class="input"
				type="password"
				bind:value={resetPassword}
				required
				autocomplete="new-password"
			/>
			<PasswordStrength password={resetPassword} username={resetTarget?.username ?? ''} />
			<button
				type="button"
				class="mt-1.5 text-[11px] text-accent hover:underline"
				onclick={() => {
					resetPassword = generatePassword();
					void (navigator.clipboard as Clipboard | undefined)?.writeText(resetPassword).then(() => {
						toast('success', 'Generated and copied to clipboard');
					});
				}}
			>
				Generate a strong password
			</button>
		</Field>
		<div class="flex justify-end gap-2">
			<button type="button" class="btn" onclick={() => (resetOpen = false)}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={busy || !resetPassword}>Reset</button>
		</div>
	</form>
</Modal>

<!-- Per-user sessions -->
<Modal bind:open={sessOpen} title="Sessions">
	{#if sessTarget}
		<div class="space-y-3">
			<div class="flex items-center justify-between gap-2">
				<p class="text-sm text-muted">
					Active sign-ins for <span class="font-medium text-fg">{sessTarget.username}</span>.
				</p>
				{#if sessList.length > 0}
					<button
						class="btn btn-ghost btn-sm shrink-0 text-xs"
						onclick={() => (sessRevokeAllOpen = true)}
					>
						Revoke all
					</button>
				{/if}
			</div>
			{#if sessBusy}
				<p class="text-sm text-faint">Loading...</p>
			{:else}
				<SessionList
					sessions={sessList}
					onrevoke={(s: SessionRow) => {
						sessRevokeTarget = s;
						sessRevokeOpen = true;
					}}
				/>
			{/if}
		</div>
	{/if}
</Modal>

<ConfirmDialog
	bind:open={sessRevokeOpen}
	title="Sign out session?"
	description={sessRevokeTarget?.current
		? 'This is your current session; you will be signed out.'
		: 'That device will need to sign in again.'}
	confirmLabel="Revoke"
	danger
	onconfirm={() => void revokeUserSession()}
/>

<ConfirmDialog
	bind:open={sessRevokeAllOpen}
	title="Revoke all sessions?"
	description={sessTarget?.id === data.user.id
		? 'Your other sessions will be signed out; this device stays signed in.'
		: `Every session for ${sessTarget?.username ?? 'this user'} will be signed out.`}
	confirmLabel="Revoke all"
	danger
	onconfirm={() => void revokeAllUserSessions()}
/>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Delete user?"
	description={`${deleteTarget?.username ?? 'This user'} will be removed and their sessions revoked.`}
	confirmLabel="Delete"
	danger
	onconfirm={() => void removeUser()}
/>

<ConfirmDialog
	bind:open={roleDeleteOpen}
	title="Delete role?"
	description={`${roleDeleteTarget?.name ?? 'This role'} will be removed.`}
	confirmLabel="Delete"
	danger
	onconfirm={() => void removeRole()}
/>

{#if keyToken !== null}
	<Modal bind:open={keyModalOpen} title="API key created">
		<div class="space-y-4">
			<p class="text-sm text-muted">
				Copy this token now; it is stored only as a hash and cannot be shown again. Use it as
				<code class="font-mono">Authorization: Bearer &lt;token&gt;</code> on
				<code class="font-mono">/api/v1/*</code>.
			</p>
			<div class="flex gap-2">
				<input class="input flex-1 font-mono text-xs" readonly value={keyToken} />
				<button class="btn" title="Copy" onclick={() => copy(keyToken ?? '')}>
					{#if copied}<Check class="size-4 text-up-fg" />{:else}<Copy class="size-4" />{/if}
				</button>
			</div>
			<div class="flex justify-end">
				<button
					class="btn btn-primary"
					onclick={() => {
						keyToken = null;
					}}
				>
					Done
				</button>
			</div>
		</div>
	</Modal>
{/if}
