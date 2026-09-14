<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Check,
		Copy,
		FingerprintPattern,
		KeyRound,
		MonitorSmartphone,
		Pencil,
		ShieldCheck,
		ShieldOff,
		Trash
	} from '@lucide/svelte';
	import { renderSVG } from 'uqr';
	import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
	import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import PasswordStrength from '$lib/components/admin/PasswordStrength.svelte';
	import Modal from '$lib/components/admin/Modal.svelte';
	import ConfirmDialog from '$lib/components/admin/ConfirmDialog.svelte';
	import SessionList from '$lib/components/admin/SessionList.svelte';
	import { api, ApiError, adminHref } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import { relativeTime } from '$lib/utils/format';
	import type { PasskeyInfo, PublicUser } from '$lib/shared/auth';

	interface Session {
		hash: string;
		createdAt: number;
		expiresAt: number;
		lastSeenAt: number;
		ip: string | null;
		userAgent: string | null;
		current: boolean;
	}

	let user = $state<PublicUser | null>(null);
	let sessions = $state<Session[]>([]);
	let loading = $state(true);
	let busy = $state(false);

	let displayName = $state('');
	let currentPw = $state('');
	let newPw = $state('');
	let confirmPw = $state('');

	// TOTP enrollment
	let totpOpen = $state(false);
	let totpSecret = $state('');
	let totpUri = $state('');
	let totpCode = $state('');
	let backupCodes = $state<string[] | null>(null);
	let disableOpen = $state(false);
	let disablePw = $state('');

	// passkeys
	let passkeys = $state<PasskeyInfo[]>([]);
	let passkeySupport = $state(false);
	let passkeyAddOpen = $state(false);
	let passkeyName = $state('');
	let passkeyRenameTarget = $state<PasskeyInfo | null>(null);
	let passkeyRenameOpen = $state(false);
	let passkeyRenameName = $state('');
	let passkeyDeleteTarget = $state<PasskeyInfo | null>(null);
	let passkeyDeleteOpen = $state(false);

	// session revoke
	let revokeTarget = $state<Session | null>(null);
	let revokeOpen = $state(false);
	let revokeAllOpen = $state(false);
	let copied = $state(false);
	let avatarInput = $state<HTMLInputElement | null>(null);
	let avatarVer = $state(0);

	const totpQr = $derived(totpUri ? renderSVG(totpUri, { border: 2 }) : '');

	async function uploadAvatar(e: Event): Promise<void> {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;
		if (file.size > 512 * 1024) {
			toast('error', 'image exceeds 512 KB');
			return;
		}
		busy = true;
		try {
			const res = await fetch(adminHref('/api/account/avatar'), {
				method: 'POST',
				body: file
			});
			if (!res.ok) {
				const b = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(b.error ?? `upload failed (${res.status})`);
			}
			toast('success', 'Avatar updated');
			avatarVer++;
			await load();
		} catch (err) {
			toast('error', err instanceof Error ? err.message : 'upload failed');
		} finally {
			busy = false;
			if (avatarInput) avatarInput.value = '';
		}
	}

	async function removeAvatar(): Promise<void> {
		busy = true;
		try {
			await api('/account/avatar', { method: 'DELETE' });
			toast('success', 'Avatar removed');
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'remove failed');
		} finally {
			busy = false;
		}
	}

	async function load(): Promise<void> {
		try {
			const r = await api<{ user: PublicUser; sessions: Session[] }>('/account');
			user = r.user;
			sessions = r.sessions;
			displayName = r.user.displayName;
			const p = await api<{ passkeys: PasskeyInfo[] }>('/account/passkeys');
			passkeys = p.passkeys;
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'load failed');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		// WebAuthn needs a secure context; hide the passkey UI on plain
		// http (outside localhost) or in browsers without support.
		passkeySupport = browserSupportsWebAuthn() && window.isSecureContext;
		void load();
	});

	async function copy(text: string): Promise<void> {
		await navigator.clipboard.writeText(text);
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}

	async function saveName(): Promise<void> {
		busy = true;
		try {
			await api('/account', { method: 'PATCH', body: { display_name: displayName } });
			toast('success', 'Display name updated');
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'save failed');
		} finally {
			busy = false;
		}
	}

	async function changePw(): Promise<void> {
		if (newPw !== confirmPw) {
			toast('error', 'new passwords do not match');
			return;
		}
		busy = true;
		try {
			await api('/account', {
				method: 'PATCH',
				body: { current_password: currentPw, new_password: newPw }
			});
			toast('success', 'Password changed; other sessions were signed out');
			currentPw = '';
			newPw = '';
			confirmPw = '';
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'change failed');
		} finally {
			busy = false;
		}
	}

	async function totpBegin(): Promise<void> {
		busy = true;
		try {
			const r = await api<{ secret: string; uri: string }>('/account/totp', {
				body: { action: 'begin' }
			});
			totpSecret = r.secret;
			totpUri = r.uri;
			totpCode = '';
			backupCodes = null;
			totpOpen = true;
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'setup failed');
		} finally {
			busy = false;
		}
	}

	async function totpConfirm(): Promise<void> {
		busy = true;
		try {
			const r = await api<{ backup_codes: string[] }>('/account/totp', {
				body: { action: 'confirm', secret: totpSecret, code: totpCode }
			});
			backupCodes = r.backup_codes;
			toast('success', 'Two-factor enabled');
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'verification failed');
		} finally {
			busy = false;
		}
	}

	async function totpDisable(): Promise<void> {
		busy = true;
		try {
			await api('/account/totp', { body: { action: 'disable', password: disablePw } });
			toast('success', 'Two-factor disabled');
			disableOpen = false;
			disablePw = '';
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'disable failed');
		} finally {
			busy = false;
		}
	}

	// Ceremony rejections surface as DOMException names (NotAllowedError
	// covers cancel and timeout); API failures carry their own message.
	function passkeyErr(err: unknown, fallback: string): string {
		if (err instanceof ApiError) return err.message;
		if (err instanceof Error && err.name === 'NotAllowedError') {
			return 'passkey ceremony was cancelled or timed out';
		}
		return fallback;
	}

	async function passkeyAdd(): Promise<void> {
		busy = true;
		try {
			const options = await api<PublicKeyCredentialCreationOptionsJSON>(
				'/account/passkeys/options',
				{ body: {} }
			);
			const attestation = await startRegistration({ optionsJSON: options });
			await api('/account/passkeys/verify', {
				body: { name: passkeyName.trim() || 'Passkey', response: attestation }
			});
			toast('success', 'Passkey added');
			passkeyAddOpen = false;
			passkeyName = '';
			await load();
		} catch (err) {
			toast('error', passkeyErr(err, 'passkey registration failed'));
		} finally {
			busy = false;
		}
	}

	async function passkeyRename(): Promise<void> {
		if (!passkeyRenameTarget) return;
		busy = true;
		try {
			await api(`/account/passkeys/${passkeyRenameTarget.id}`, {
				method: 'PATCH',
				body: { name: passkeyRenameName }
			});
			toast('success', 'Passkey renamed');
			passkeyRenameOpen = false;
			passkeyRenameTarget = null;
			await load();
		} catch (err) {
			toast('error', passkeyErr(err, 'rename failed'));
		} finally {
			busy = false;
		}
	}

	async function passkeyDelete(): Promise<void> {
		if (!passkeyDeleteTarget) return;
		try {
			await api(`/account/passkeys/${passkeyDeleteTarget.id}`, { method: 'DELETE' });
			toast('success', 'Passkey removed');
			passkeyDeleteTarget = null;
			passkeyDeleteOpen = false;
			await load();
		} catch (err) {
			toast('error', passkeyErr(err, 'remove failed'));
		}
	}

	async function revokeAllSessions(): Promise<void> {
		try {
			await api('/account/sessions', { method: 'DELETE' });
			toast('success', 'Other sessions signed out');
			revokeAllOpen = false;
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'revoke failed');
		}
	}

	async function revokeSession(): Promise<void> {
		if (!revokeTarget) return;
		try {
			await api(`/account/sessions/${revokeTarget.hash}`, { method: 'DELETE' });
			toast('success', 'Session revoked');
			revokeTarget = null;
			revokeOpen = false;
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'revoke failed');
		}
	}
</script>

<PageHeader title="Account" description="Your profile, password, and sign-in sessions" />

{#if loading || !user}
	<div class="grid gap-6 lg:grid-cols-2">
		<div class="card h-64 animate-pulse"></div>
		<div class="card h-64 animate-pulse"></div>
	</div>
{:else}
	<div class="grid gap-6 lg:grid-cols-2">
		<section class="card p-5">
			<h2 class="mb-4 text-sm font-semibold">Profile</h2>
			<div class="space-y-4">
				<div class="flex items-center gap-3">
					{#if user.hasAvatar}
						<img
							class="size-12 rounded-full border border-edge object-cover"
							src="{adminHref(`/api/avatar/${user.id}`)}?v={avatarVer}"
							alt="Your avatar"
						/>
					{:else}
						<span
							class="flex size-12 items-center justify-center rounded-full border border-edge bg-raised text-lg font-medium text-muted"
						>
							{(user.displayName || user.username).slice(0, 1).toUpperCase()}
						</span>
					{/if}
					<div class="flex gap-2">
						<button class="btn btn-sm" disabled={busy} onclick={() => avatarInput?.click()}>
							{user.hasAvatar ? 'Change' : 'Upload'} avatar
						</button>
						{#if user.hasAvatar}
							<button class="btn btn-ghost btn-sm" disabled={busy} onclick={removeAvatar}>
								Remove
							</button>
						{/if}
					</div>
					<input
						bind:this={avatarInput}
						type="file"
						class="hidden"
						accept="image/png,image/jpeg,image/webp,image/gif"
						onchange={uploadAvatar}
					/>
				</div>
				<p class="text-xs text-faint">PNG, JPEG, WebP, or GIF up to 512 KB.</p>
				<Field label="Username">
					<input class="input" value={user.username} disabled />
				</Field>
				<Field label="Display name" hint="Shown in the audit log and header.">
					<input class="input" bind:value={displayName} />
				</Field>
				<div class="flex justify-end">
					<button
						class="btn btn-primary"
						disabled={busy || displayName === user.displayName}
						onclick={saveName}
					>
						Save name
					</button>
				</div>
			</div>
		</section>

		<section class="card p-5">
			<h2 class="mb-4 flex items-center gap-2 text-sm font-semibold">
				<KeyRound class="size-4" /> Password
			</h2>
			<form
				class="space-y-4"
				onsubmit={(e) => {
					e.preventDefault();
					void changePw();
				}}
			>
				<Field label="Current password" required>
					<input
						class="input"
						type="password"
						bind:value={currentPw}
						required
						autocomplete="current-password"
					/>
				</Field>
				<Field label="New password" required>
					<input
						class="input"
						type="password"
						bind:value={newPw}
						required
						autocomplete="new-password"
					/>
					<PasswordStrength password={newPw} username={user.username} />
				</Field>
				<Field label="Confirm new password" required>
					<input
						class="input"
						type="password"
						bind:value={confirmPw}
						required
						autocomplete="new-password"
					/>
					{#if confirmPw && confirmPw !== newPw}
						<p class="mt-1 text-[11px] text-down-fg">passwords do not match</p>
					{/if}
				</Field>
				<div class="flex justify-end">
					<button type="submit" class="btn btn-primary" disabled={busy || !currentPw || !newPw}>
						Change password
					</button>
				</div>
			</form>
		</section>

		<section class="card p-5">
			<h2 class="mb-4 flex items-center gap-2 text-sm font-semibold">
				{#if user.totpEnabled}<ShieldCheck class="size-4 text-up-fg" />{:else}<ShieldOff
						class="size-4 text-faint"
					/>{/if}
				Two-factor authentication
			</h2>
			{#if user.totpEnabled}
				<p class="mb-4 text-sm text-muted">
					TOTP is enabled. You will need your authenticator app or a backup code to sign in.
				</p>
				<button class="btn btn-danger" onclick={() => (disableOpen = true)}>Disable 2FA</button>
			{:else}
				<p class="mb-4 text-sm text-muted">
					Add a one-time-code step to sign-in. Any RFC 6238 authenticator works.
				</p>
				<button class="btn btn-primary" disabled={busy} onclick={totpBegin}>Enable 2FA</button>
			{/if}
		</section>

		{#if passkeySupport}
			<section class="card p-5">
				<div class="mb-4 flex items-center justify-between gap-2">
					<h2 class="flex items-center gap-2 text-sm font-semibold">
						<FingerprintPattern class="size-4" /> Passkeys
					</h2>
					<button
						class="btn btn-primary btn-sm"
						disabled={busy}
						onclick={() => {
							passkeyName = '';
							passkeyAddOpen = true;
						}}
					>
						Add passkey
					</button>
				</div>
				{#if passkeys.length === 0}
					<p class="text-sm text-faint">
						No passkeys yet. A passkey signs you in with this device or a security key instead of a
						password.
					</p>
				{:else}
					<ul class="divide-y divide-edge">
						{#each passkeys as k (k.id)}
							<li class="flex items-center gap-3 py-2.5 text-sm">
								<FingerprintPattern class="size-5 shrink-0 text-faint" />
								<div class="min-w-0 flex-1">
									<p class="truncate text-fg">{k.name}</p>
									<p class="truncate text-xs text-faint">
										added {relativeTime(k.createdAt)} ·
										{k.lastUsedAt ? `used ${relativeTime(k.lastUsedAt)}` : 'never used'}
									</p>
								</div>
								<button
									class="btn btn-ghost btn-sm shrink-0"
									title="Rename"
									onclick={() => {
										passkeyRenameTarget = k;
										passkeyRenameName = k.name;
										passkeyRenameOpen = true;
									}}
								>
									<Pencil class="size-3.5" />
								</button>
								<button
									class="btn btn-ghost btn-sm shrink-0"
									title="Delete"
									onclick={() => {
										passkeyDeleteTarget = k;
										passkeyDeleteOpen = true;
									}}
								>
									<Trash class="size-3.5" />
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}

		<section class="card p-5">
			<div class="mb-4 flex items-center justify-between gap-2">
				<h2 class="flex items-center gap-2 text-sm font-semibold">
					<MonitorSmartphone class="size-4" /> Sessions
				</h2>
				{#if sessions.some((s) => !s.current)}
					<button class="btn btn-ghost btn-sm text-xs" onclick={() => (revokeAllOpen = true)}>
						Sign out others
					</button>
				{/if}
			</div>
			<SessionList
				{sessions}
				onrevoke={(s: Session) => {
					revokeTarget = s;
					revokeOpen = true;
				}}
			/>
		</section>
	</div>
{/if}

<!-- TOTP enrollment -->
<Modal bind:open={totpOpen} title="Enable two-factor">
	{#if backupCodes === null}
		<div class="space-y-4">
			<p class="text-sm text-muted">
				Scan the code with your authenticator app, or enter the secret manually.
			</p>
			<div class="flex justify-center">
				<div
					class="inline-block rounded-lg bg-white p-2 [&>svg]:block [&>svg]:size-44"
					aria-label="TOTP QR code"
				>
					<!-- eslint-disable-next-line svelte/no-at-html-tags -- uqr emits rect-only SVG built from the matrix; the URI is not embedded in markup -->
					{@html totpQr}
				</div>
			</div>
			<Field label="Secret" hint="Base32 TOTP secret.">
				<div class="flex gap-2">
					<input class="input flex-1 font-mono text-xs" readonly value={totpSecret} />
					<button type="button" class="btn" title="Copy" onclick={() => copy(totpSecret)}>
						{#if copied}<Check class="size-4 text-up-fg" />{:else}<Copy class="size-4" />{/if}
					</button>
				</div>
			</Field>
			<details class="text-xs text-faint">
				<summary class="cursor-pointer hover:text-muted">Show otpauth URI</summary>
				<input class="input mt-1.5 font-mono text-xs" readonly value={totpUri} />
			</details>
			<form
				class="flex items-end gap-2"
				onsubmit={(e) => {
					e.preventDefault();
					void totpConfirm();
				}}
			>
				<Field label="Code from app" required>
					<input
						class="input font-mono"
						bind:value={totpCode}
						inputmode="numeric"
						autocomplete="one-time-code"
						required
					/>
				</Field>
				<button type="submit" class="btn btn-primary" disabled={busy || !totpCode.trim()}
					>Verify</button
				>
			</form>
		</div>
	{:else}
		<div class="space-y-4">
			<p class="text-sm text-muted">
				Two-factor is on. Save these backup codes somewhere safe; each works once when you lose your
				authenticator. They are shown only now.
			</p>
			<div class="grid grid-cols-2 gap-1.5">
				{#each backupCodes as c (c)}
					<code class="card px-2 py-1 text-center text-xs">{c}</code>
				{/each}
			</div>
			<div class="flex justify-end gap-2">
				<button class="btn" onclick={() => copy(backupCodes?.join('\n') ?? '')}>Copy all</button>
				<button
					class="btn btn-primary"
					onclick={() => {
						totpOpen = false;
						backupCodes = null;
					}}
				>
					Done
				</button>
			</div>
		</div>
	{/if}
</Modal>

<!-- TOTP disable -->
<Modal bind:open={disableOpen} title="Disable two-factor">
	<form
		class="space-y-4"
		onsubmit={(e) => {
			e.preventDefault();
			void totpDisable();
		}}
	>
		<p class="text-sm text-muted">Enter your password to disable TOTP on this account.</p>
		<Field label="Password" required>
			<input
				class="input"
				type="password"
				bind:value={disablePw}
				required
				autocomplete="current-password"
			/>
		</Field>
		<div class="flex justify-end gap-2">
			<button type="button" class="btn" onclick={() => (disableOpen = false)}>Cancel</button>
			<button type="submit" class="btn btn-danger" disabled={busy || !disablePw}>Disable</button>
		</div>
	</form>
</Modal>

<ConfirmDialog
	bind:open={revokeOpen}
	title="Sign out session?"
	description={revokeTarget?.current
		? 'This is your current session; you will be signed out.'
		: 'That device will need to sign in again.'}
	confirmLabel="Revoke"
	danger
	onconfirm={() => void revokeSession()}
/>

<ConfirmDialog
	bind:open={revokeAllOpen}
	title="Sign out all other sessions?"
	description="Every other device will need to sign in again. This device stays signed in."
	confirmLabel="Sign out others"
	danger
	onconfirm={() => void revokeAllSessions()}
/>

<!-- Passkey add -->
<Modal bind:open={passkeyAddOpen} title="Add a passkey">
	<form
		class="space-y-4"
		onsubmit={(e) => {
			e.preventDefault();
			void passkeyAdd();
		}}
	>
		<p class="text-sm text-muted">
			Your device or security key will ask to create a passkey for this account.
		</p>
		<Field label="Name" hint="A label to tell this passkey apart, e.g. YubiKey 5 or MacBook.">
			<input class="input" bind:value={passkeyName} maxlength="80" placeholder="Passkey" />
		</Field>
		<div class="flex justify-end gap-2">
			<button type="button" class="btn" onclick={() => (passkeyAddOpen = false)}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={busy}>Create passkey</button>
		</div>
	</form>
</Modal>

<!-- Passkey rename -->
<Modal bind:open={passkeyRenameOpen} title="Rename passkey">
	<form
		class="space-y-4"
		onsubmit={(e) => {
			e.preventDefault();
			void passkeyRename();
		}}
	>
		<Field label="Name" required>
			<input class="input" bind:value={passkeyRenameName} maxlength="80" required />
		</Field>
		<div class="flex justify-end gap-2">
			<button type="button" class="btn" onclick={() => (passkeyRenameOpen = false)}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={busy || !passkeyRenameName.trim()}>
				Save
			</button>
		</div>
	</form>
</Modal>

<ConfirmDialog
	bind:open={passkeyDeleteOpen}
	title="Delete this passkey?"
	description={passkeyDeleteTarget
		? `"${passkeyDeleteTarget.name}" will no longer sign you in. This cannot be undone.`
		: 'This passkey will no longer sign you in.'}
	confirmLabel="Delete"
	danger
	onconfirm={() => void passkeyDelete()}
/>
