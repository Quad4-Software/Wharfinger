<script lang="ts">
	import type { ServiceStatus } from '$lib/shared/status';
	import { STATUS_KEYS } from '$lib/i18n';
	import { t } from '$lib/i18n/locale.svelte';
	import { STATUS_PILL } from '$lib/utils/status-style';

	const { status }: { status: ServiceStatus } = $props();
</script>

<span
	class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset {STATUS_PILL[
		status
	]}"
>
	{t(STATUS_KEYS[status])}
</span>
