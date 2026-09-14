<script lang="ts">
	import { resolve } from '$app/paths';
	import SubscribeForm from './SubscribeForm.svelte';

	const { siteName, refreshSeconds }: { siteName: string; refreshSeconds: number } = $props();
	const year = new Date().getFullYear();
</script>

<footer class="border-t border-edge pt-6 pb-10 text-xs text-faint">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			{siteName}
			{year} · checks run automatically and refresh every {refreshSeconds}s
		</div>
		<div class="flex items-center gap-4">
			<SubscribeForm />
			<a href={resolve('/feed.xml')} class="transition-colors hover:text-muted">RSS</a>
			<a href={resolve('/api/status')} class="transition-colors hover:text-muted">JSON API</a>
		</div>
	</div>
</footer>
