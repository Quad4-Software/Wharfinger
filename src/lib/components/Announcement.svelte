<script lang="ts">
	import { Info, TriangleAlert, OctagonAlert } from '@lucide/svelte';
	import type { StatusSnapshot } from '$lib/shared/types';

	const { announcement }: { announcement: NonNullable<StatusSnapshot['site']['announcement']> } =
		$props();

	const styles = {
		info: 'border-maint/25 bg-maint/8 text-maint-fg',
		warning: 'border-degraded/25 bg-degraded/8 text-degraded-fg',
		critical: 'border-down/25 bg-down/8 text-down-fg'
	} as const;
	const icons = { info: Info, warning: TriangleAlert, critical: OctagonAlert } as const;
	const Icon = $derived(icons[announcement.severity]);
</script>

<div
	class="flex items-start gap-3 rounded-xl border px-4 py-3 text-sm {styles[announcement.severity]}"
	role="status"
>
	<Icon class="mt-0.5 size-4 shrink-0" />
	<p>{announcement.text}</p>
</div>
