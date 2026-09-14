<script lang="ts">
	import AuthCard from '$lib/components/admin/AuthCard.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import PasswordStrength from '$lib/components/admin/PasswordStrength.svelte';
	import { adminHref, api, ApiError } from '$lib/state/admin.svelte';

	let username = $state('');
	let displayName = $state('');
	let password = $state('');
	let confirm = $state('');
	let website = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);

	async function submit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (password !== confirm) {
			error = 'passwords do not match';
			return;
		}
		busy = true;
		error = null;
		try {
			await api('/auth/setup', {
				body: { username, display_name: displayName, password, website }
			});
			location.href = adminHref('/');
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'setup failed';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Setup · Status panel</title>
</svelte:head>

<AuthCard title="Welcome" subtitle="Create the first admin account">
	<form class="space-y-4" onsubmit={submit}>
		<Field label="Username" required>
			<input class="input" bind:value={username} autocomplete="username" required />
		</Field>
		<Field label="Display name" hint="Optional, shown in the panel.">
			<input class="input" bind:value={displayName} autocomplete="name" />
		</Field>
		<Field label="Password" required>
			<input
				class="input"
				type="password"
				bind:value={password}
				autocomplete="new-password"
				required
			/>
			<PasswordStrength {password} {username} />
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
			{busy ? 'Creating...' : 'Create admin account'}
		</button>
	</form>
</AuthCard>
