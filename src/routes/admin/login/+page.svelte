<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { FingerprintPattern, LoaderCircle } from '@lucide/svelte';
	import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
	import type {
		AuthenticationResponseJSON,
		PublicKeyCredentialRequestOptionsJSON
	} from '@simplewebauthn/browser';
	import AuthCard from '$lib/components/admin/AuthCard.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import { adminHref, api, ApiError, safeNext } from '$lib/state/admin.svelte';

	const {
		data
	}: {
		data: {
			setupNeeded: boolean;
			sso: { label: string } | null;
		};
	} = $props();

	let username = $state('');
	let password = $state('');
	let totp = $state('');
	let website = $state('');
	let totpRequired = $state(false);
	let busy = $state(false);
	let passkeySupport = $state(false);
	// Assertion awaiting its TOTP retry; keeps the ceremony result so
	// the user does not touch the key again to submit the code.
	let passkeyAssertion = $state<AuthenticationResponseJSON | null>(null);

	onMount(() => {
		// WebAuthn needs a secure context; offer passkey sign-in only on
		// https or localhost in a browser that supports it.
		passkeySupport = browserSupportsWebAuthn() && window.isSecureContext;
	});

	const next = $derived(page.url.searchParams.get('next') ?? adminHref('/'));

	const ERROR_TEXT: Record<string, string> = {
		oidc_state: 'SSO session expired; try again',
		oidc_denied: 'Your account is not permitted to sign in',
		oidc_disabled: 'This account has been disabled',
		oidc_unavailable: 'SSO is temporarily unavailable',
		oidc_error: 'SSO sign-in failed'
	};
	let localError = $state<string | null>(null);
	const urlError = $derived(page.url.searchParams.get('error'));
	const error = $derived<string | null>((urlError ? ERROR_TEXT[urlError] : null) ?? localError);

	async function passkeyVerify(assertion: AuthenticationResponseJSON): Promise<void> {
		const res = await api<{ ok?: boolean; totp_required?: boolean }>('/auth/passkey/verify', {
			body: { response: assertion, totp: totp || undefined }
		});
		if (res.totp_required) {
			passkeyAssertion = assertion;
			totpRequired = true;
			return;
		}
		location.href = safeNext(next);
	}

	// Discoverable-credential flow: no username sent, the authenticator
	// picks the account.
	async function passkeyLogin(): Promise<void> {
		if (busy) return;
		busy = true;
		localError = null;
		passkeyAssertion = null;
		try {
			const options = await api<PublicKeyCredentialRequestOptionsJSON>('/auth/passkey/options', {
				body: {}
			});
			const assertion = await startAuthentication({ optionsJSON: options });
			await passkeyVerify(assertion);
		} catch (err) {
			passkeyAssertion = null;
			localError =
				err instanceof ApiError
					? err.message
					: err instanceof Error && err.name === 'NotAllowedError'
						? 'passkey ceremony was cancelled or timed out'
						: 'passkey sign-in failed';
		} finally {
			busy = false;
		}
	}

	function passkeyCancel(): void {
		passkeyAssertion = null;
		totpRequired = false;
		totp = '';
		localError = null;
	}

	async function submit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (busy) return;
		busy = true;
		localError = null;
		try {
			if (passkeyAssertion) {
				// Second leg of a passkey sign-in: resend the held
				// assertion with the TOTP code.
				await passkeyVerify(passkeyAssertion);
				return;
			}
			const res = await api<{ ok?: boolean; totp_required?: boolean }>('/auth/login', {
				body: { username, password, totp: totp || undefined, website }
			});
			if (res.totp_required) {
				totpRequired = true;
				return;
			}
			location.href = safeNext(next);
		} catch (err) {
			localError = err instanceof ApiError ? err.message : 'sign-in failed';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Sign in · Status panel</title>
</svelte:head>

<AuthCard title="Sign in" subtitle="Status panel">
	<form class="space-y-4" onsubmit={submit}>
		{#if passkeyAssertion}
			<p class="text-sm text-muted">
				Passkey accepted. Enter your two-factor code to finish signing in.
			</p>
		{:else}
			<Field label="Username" required>
				<input class="input" bind:value={username} autocomplete="username" required />
			</Field>
			<Field label="Password" required>
				<input
					class="input"
					type="password"
					bind:value={password}
					autocomplete="current-password"
					required
				/>
			</Field>
		{/if}
		{#if totpRequired}
			<Field label="Authenticator or backup code" required>
				<input
					class="input"
					bind:value={totp}
					inputmode="numeric"
					autocomplete="one-time-code"
					placeholder="123456"
					required
				/>
			</Field>
		{/if}
		<!-- Honeypot: invisible to humans, filled by naive bots. -->
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
			{#if busy}<LoaderCircle class="size-4 animate-spin" />{/if}
			{busy ? 'Signing in...' : 'Sign in'}
		</button>
		{#if passkeyAssertion}
			<p class="text-center text-xs text-faint">
				<button type="button" class="text-accent hover:underline" onclick={passkeyCancel}>
					Cancel and use password instead
				</button>
			</p>
		{/if}
		{#if !passkeyAssertion && (passkeySupport || data.sso)}
			<div class="relative flex items-center py-1">
				<div class="flex-1 border-t border-edge"></div>
				<span class="px-3 text-xs text-faint">or</span>
				<div class="flex-1 border-t border-edge"></div>
			</div>
		{/if}
		{#if !passkeyAssertion && passkeySupport}
			<button
				type="button"
				class="btn btn-ghost w-full justify-center"
				disabled={busy}
				onclick={() => void passkeyLogin()}
			>
				<FingerprintPattern class="size-4" />
				{busy ? 'Waiting for authenticator...' : 'Sign in with a passkey'}
			</button>
		{/if}
		{#if data.sso}
			<a
				class="btn btn-ghost w-full justify-center"
				href={adminHref(`/api/auth/oidc/start?next=${encodeURIComponent(next)}`)}
			>
				{data.sso.label}
			</a>
		{/if}
		{#if data.setupNeeded}
			<p class="text-center text-xs text-faint">
				No accounts yet? <a class="text-accent hover:underline" href={adminHref('/setup')}
					>Create the first admin</a
				>
			</p>
		{/if}
	</form>
</AuthCard>
