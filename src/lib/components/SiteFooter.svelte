<script lang="ts">
	import { resolve } from '$app/paths';
	import { LOCALES, LOCALE_NAMES } from '$lib/i18n';
	import { getLocale, setLocale, t } from '$lib/i18n/locale.svelte';
	import SubscribeForm from './SubscribeForm.svelte';

	const { siteName, refreshSeconds }: { siteName: string; refreshSeconds: number } = $props();
	const year = new Date().getFullYear();
</script>

<footer class="border-t border-edge pt-6 pb-10 text-xs text-faint">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			{siteName}
			{year} · {t('status.footer_refresh', { n: refreshSeconds })}
		</div>
		<div class="flex items-center gap-4">
			{#if LOCALES.length > 1}
				<select
					aria-label={t('status.language')}
					class="cursor-pointer bg-transparent transition-colors hover:text-muted"
					value={getLocale()}
					onchange={(e) => {
						setLocale(e.currentTarget.value);
					}}
				>
					{#each LOCALES as l (l)}
						<option value={l}>{LOCALE_NAMES[l] ?? l}</option>
					{/each}
				</select>
			{/if}
			<SubscribeForm />
			<a href={resolve('/feed.xml')} class="transition-colors hover:text-muted">RSS</a>
			<a href={resolve('/api/status')} class="transition-colors hover:text-muted">JSON API</a>
		</div>
	</div>
</footer>
