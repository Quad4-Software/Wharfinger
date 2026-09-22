<script lang="ts">
	import { page } from '$app/state';
	import { invalidateAll, goto } from '$app/navigation';
	import { adminHref } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import { Check, Copy, House, RotateCcw, TriangleAlert } from '@lucide/svelte';
	import { sendClientReport } from '$lib/shared/telemetry';

	let copied = $state(false);
	let retrying = $state(false);

	const errText = $derived(
		page.error instanceof Error
			? `${page.error.name}: ${page.error.message}`
			: (page.error?.message ?? '')
	);

	function debugText(): string {
		const err = page.error;
		return [
			'wharfinger admin crash report',
			`status: ${page.status}`,
			`error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
			err instanceof Error && err.stack ? `stack:\n${err.stack}` : null,
			`url: ${page.url.href}`,
			`route: ${page.route.id ?? '(none)'}`,
			`time: ${new Date().toISOString()}`,
			`userAgent: ${navigator.userAgent}`
		]
			.filter((l) => l !== null)
			.join('\n');
	}

	async function copyDebug(): Promise<void> {
		try {
			await navigator.clipboard.writeText(debugText());
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			toast('error', 'copy failed');
		}
	}

	async function retry(): Promise<void> {
		retrying = true;
		try {
			// Re-run the load functions; a transient API failure recovers
			// without losing page state.
			await invalidateAll();
			await goto(page.url, { replaceState: true });
		} catch {
			location.reload();
		} finally {
			retrying = false;
		}
	}

	// Report once per render of the error surface.
	$effect(() => {
		const err = page.error;
		sendClientReport({
			name: err instanceof Error ? err.name : 'Error',
			message: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
			url: page.url.href,
			routeId: page.route.id ?? undefined,
			handled: true,
			mechanism: 'route-error'
		});
	});
</script>

<svelte:head>
	<title>{page.status} · Wharfinger</title>
</svelte:head>

<div class="mx-auto flex max-w-lg flex-col items-center py-16 text-center md:py-24">
	<div
		class="flex size-14 items-center justify-center rounded-2xl border border-degraded/40 bg-degraded/10"
	>
		<TriangleAlert class="size-7 text-degraded-fg" />
	</div>
	<p class="mt-5 text-xs font-medium tracking-widest text-faint uppercase">
		{page.status}
	</p>
	<h1 class="mt-2 text-xl font-semibold text-fg">Something broke on this page</h1>
	<p class="mt-2 max-w-md text-sm text-muted">
		{errText || 'The panel hit an unexpected error.'}
	</p>
	{#if page.error?.errorId}
		<p class="mt-1 font-mono text-xs text-faint">error id {page.error.errorId}</p>
	{/if}
	<div class="mt-6 flex flex-wrap items-center justify-center gap-2">
		<button class="btn btn-primary" disabled={retrying} onclick={() => void retry()}>
			<RotateCcw class="size-4 {retrying ? 'animate-spin' : ''}" /> Try again
		</button>
		<a class="btn" href={adminHref('/')}>
			<House class="size-4" /> Dashboard
		</a>
		<button class="btn btn-ghost" onclick={() => void copyDebug()}>
			{#if copied}<Check class="size-4 text-up-fg" />{:else}<Copy class="size-4" />{/if} Copy debug info
		</button>
	</div>
	<p class="mt-6 max-w-md text-xs text-faint">
		If this keeps happening, the debug info above identifies the failing route. The crash was
		reported to local telemetry when enabled.
	</p>
</div>
