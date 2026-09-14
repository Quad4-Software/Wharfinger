<script lang="ts">
	import { Webhook } from '@lucide/svelte';

	let open = $state(false);
	let url = $state('');
	let busy = $state(false);
	let done = $state(false);
	let failed = $state(false);

	async function submit(): Promise<void> {
		const u = url.trim();
		if (!u || busy) return;
		busy = true;
		failed = false;
		try {
			const res = await fetch('/api/subscribe', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url: u })
			});
			if (!res.ok) throw new Error(String(res.status));
			done = true;
		} catch {
			failed = true;
		} finally {
			busy = false;
		}
	}
</script>

{#if !open}
	<button
		type="button"
		class="inline-flex items-center gap-1.5 transition-colors hover:text-muted"
		aria-expanded={open}
		onclick={() => {
			open = true;
		}}
	>
		<Webhook class="size-3.5" /> Subscribe
	</button>
{:else}
	<div class="flex flex-col gap-1.5">
		{#if done}
			<p class="text-muted">
				Confirmation sent. The webhook will receive a link to activate the subscription.
			</p>
		{:else}
			<form
				class="flex items-center gap-2"
				onsubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				<input
					class="input w-56 text-xs"
					type="url"
					placeholder="https://example.com/hook"
					aria-label="Webhook URL"
					bind:value={url}
					required
				/>
				<button class="btn btn-sm" type="submit" disabled={busy || !url.trim()}>
					{busy ? 'Sending...' : 'Subscribe'}
				</button>
			</form>
			{#if failed}
				<p class="text-down" role="alert">Could not register that webhook URL.</p>
			{/if}
			<p class="text-faint">Status events will be POSTed there, HMAC-signed.</p>
		{/if}
	</div>
{/if}
