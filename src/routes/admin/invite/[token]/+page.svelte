<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import AuthCard from '$lib/components/admin/AuthCard.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import PasswordStrength from '$lib/components/admin/PasswordStrength.svelte';
	import { adminHref, api, ApiError } from '$lib/state/admin.svelte';

	interface InviteInfo {
		valid: boolean;
		kind?: 'invite' | 'reset';
		role?: string;
		username?: string | null;
		expires_at?: number;
	}

	let info = $state<InviteInfo | null>(null);
	let username = $state('');
	let displayName = $state('');
	let password = $state('');
	let confirm = $state('');
	let website = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);
	let done = $state(false);

	const token = $derived(page.params.token ?? '');

	onMount(async () => {
		try {
			info = await api<InviteInfo>(`/invite/${token}`);
			if (info.username) username = info.username;
		} catch {
			info = { valid: false };
		}
	});

	async function submit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (password !== confirm) {
			error = 'passwords do not match';
			return;
		}
		busy = true;
		error = null;
		try {
			await api(`/invite/${token}`, {
				body: { username, display_name: displayName, password, website }
			});
			done = true;
			setTimeout(() => (location.href = adminHref('/')), 1200);
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'could not use this link';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Invite · Status panel</title>
</svelte:head>

{#if info === null}
	<div class="flex min-h-screen items-center justify-center">
		<p class="text-sm text-faint">Checking link...</p>
	</div>
{:else if !info.valid}
	<AuthCard title="Link unavailable" subtitle="Invite or reset link">
		<p class="text-sm leading-relaxed text-muted">
			This link is invalid, expired, revoked, or already used. Ask an admin for a new one.
		</p>
		<a class="btn mt-5 w-full" href={adminHref('/login')}>Go to sign in</a>
	</AuthCard>
{:else if done}
	<AuthCard title="All set" subtitle="Redirecting you to the panel">
		<p class="text-sm text-up-fg">
			{info.kind === 'reset' ? 'Password updated.' : 'Account created.'} Signing you in...
		</p>
	</AuthCard>
{:else}
	<AuthCard
		title={info.kind === 'reset' ? 'Reset your password' : `Join as ${info.role}`}
		subtitle="Status panel access"
	>
		<form class="space-y-4" onsubmit={submit}>
			{#if info.kind === 'invite'}
				<Field label="Username" required>
					<input class="input" bind:value={username} autocomplete="username" required />
				</Field>
				<Field label="Display name" hint="Optional.">
					<input class="input" bind:value={displayName} autocomplete="name" />
				</Field>
			{:else}
				<p class="text-sm text-muted">
					Setting a new password for <span class="font-medium text-fg">{info.username}</span>.
				</p>
			{/if}
			<Field label="New password" required>
				<input
					class="input"
					type="password"
					bind:value={password}
					autocomplete="new-password"
					required
				/>
				<PasswordStrength
					{password}
					username={username !== '' ? username : (info.username ?? '')}
				/>
			</Field>
			<Field label="Confirm password" required>
				<input
					class="input"
					type="password"
					bind:value={confirm}
					autocomplete="new-password"
					required
				/>
				{#if confirm && confirm !== password}
					<p class="mt-1 text-[11px] text-down-fg">passwords do not match</p>
				{/if}
			</Field>
			<input
				class="absolute -left-[9999px] h-0 w-0 opacity-0"
				bind:value={website}
				name="website"
				tabindex="-1"
				autocomplete="off"
				aria-hidden="true"
			/>
			{#if error}<p class="text-sm text-down-fg" role="alert">{error}</p>{/if}
			<button class="btn btn-primary w-full" type="submit" disabled={busy}>
				{busy ? 'Working...' : info.kind === 'reset' ? 'Set new password' : 'Create account'}
			</button>
		</form>
	</AuthCard>
{/if}
