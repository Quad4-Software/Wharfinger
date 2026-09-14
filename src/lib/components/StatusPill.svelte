<script lang="ts">
	import { STATUS_LABEL, type ServiceStatus } from '$lib/shared/status';
	import { STATUS_PILL } from '$lib/utils/status-style';

	const { status }: { status: ServiceStatus } = $props();
</script>

<span
	class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset {STATUS_PILL[
		status
	]}"
>
	{STATUS_LABEL[status]}
</span>
