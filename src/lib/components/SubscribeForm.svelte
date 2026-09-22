<script lang="ts">
	import { Webhook } from '@lucide/svelte';
	import { t } from '$lib/i18n/locale.svelte';

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
		<Webhook class="size-3.5" />
		{t('subscribe.cta')}
	</button>
{:else}
	<div class="flex flex-col gap-1.5">
		{#if done}
			<p class="text-muted">
				{t('subscribe.sent')}
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
					aria-label={t('subscribe.url_label')}
					bind:value={url}
					required
				/>
				<button class="btn btn-sm" type="submit" disabled={busy || !url.trim()}>
					{busy ? t('subscribe.sending') : t('subscribe.cta')}
				</button>
			</form>
			{#if failed}
				<p class="text-down" role="alert">{t('subscribe.failed')}</p>
			{/if}
			<p class="text-faint">{t('subscribe.hint')}</p>
		{/if}
	</div>
{/if}
