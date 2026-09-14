<script lang="ts">
	import { version } from '$app/environment';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Check, Copy, House, TriangleAlert } from '@lucide/svelte';

	const {
		status,
		message = 'Something went wrong',
		errorId = null,
		homeHref = '/',
		homeLabel = 'Back to status'
	}: {
		status: number;
		message?: string;
		errorId?: string | null;
		homeHref?: string;
		homeLabel?: string;
	} = $props();

	let copied = $state(false);

	const title = $derived(
		status === 404
			? 'Page not found'
			: status === 429
				? 'Too many requests'
				: status >= 500
					? 'Something went wrong'
					: 'Request failed'
	);
	const hint = $derived(
		status === 404
			? 'The page you are looking for does not exist or was moved.'
			: status === 429
				? 'Slow down and try again in a minute.'
				: status >= 500
					? 'The failure was logged automatically. Paste the debug info into a bug report if it keeps happening.'
					: null
	);

	function debugText(): string {
		return [
			'status page error report',
			`status: ${status}`,
			`message: ${message}`,
			errorId ? `errorId: ${errorId}` : null,
			`url: ${page.url.href}`,
			`route: ${page.route.id ?? '(none)'}`,
			`time: ${new Date().toISOString()}`,
			`version: ${version}`,
			`userAgent: ${typeof navigator === 'undefined' ? 'n/a' : navigator.userAgent}`
		]
			.filter((l) => l !== null)
			.join('\n');
	}

	async function copyDebug(): Promise<void> {
		try {
			await navigator.clipboard.writeText(debugText());
			copied = true;
			setTimeout(() => {
				copied = false;
			}, 2000);
		} catch {
			// Clipboard API unavailable or permission denied.
		}
	}
</script>

<div class="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center px-4">
	<div class="card w-full p-8 text-center">
		<div
			class="mx-auto flex size-12 items-center justify-center rounded-xl ring-1 ring-edge"
			style="background: color-mix(in srgb, var(--color-degraded) 14%, transparent)"
		>
			<TriangleAlert class="size-6 text-degraded" />
		</div>
		<p class="mt-5 font-mono text-sm tracking-widest text-faint">{status}</p>
		<h1 class="mt-1 text-xl font-semibold tracking-tight">{title}</h1>
		<p class="mt-2 text-sm text-muted">{message}</p>
		{#if hint}<p class="mt-3 text-xs text-faint">{hint}</p>{/if}
		{#if errorId}<p class="mt-3 font-mono text-xs text-faint">error id: {errorId}</p>{/if}
		<div class="mt-6 flex flex-wrap items-center justify-center gap-2">
			<a class="btn btn-primary" href={resolve(homeHref as '/')}
				><House class="size-4" />{homeLabel}</a
			>
			<button class="btn" onclick={copyDebug}>
				{#if copied}<Check class="size-4" />Copied{:else}<Copy class="size-4" />Copy debug info{/if}
			</button>
		</div>
	</div>
</div>
