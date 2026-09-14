<script lang="ts">
	import type { Snippet } from 'svelte';
	import { version } from '$app/environment';
	import { page } from '$app/state';
	import { sendClientReport } from '$lib/shared/telemetry';
	import { Check, Copy, RotateCcw, TriangleAlert } from '@lucide/svelte';

	const { children }: { children: Snippet } = $props();

	let copied = $state(false);

	// Boundary errors do not reach hooks.client handleError, so the
	// report is sent from here.
	function report(error: unknown): void {
		const err = error instanceof Error ? error : new Error(String(error));
		sendClientReport({
			name: err.name,
			message: err.message,
			stack: err.stack,
			url: page.url.href,
			routeId: page.route.id ?? undefined,
			handled: true,
			mechanism: 'svelte-boundary'
		});
	}

	function describe(error: unknown): string {
		return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	}

	function debugText(error: unknown): string {
		const err = error instanceof Error ? error : new Error(String(error));
		return [
			'status page crash report',
			`error: ${err.name}: ${err.message}`,
			err.stack ? `stack:\n${err.stack}` : null,
			`url: ${page.url.href}`,
			`route: ${page.route.id ?? '(none)'}`,
			`time: ${new Date().toISOString()}`,
			`version: ${version}`,
			`userAgent: ${typeof navigator === 'undefined' ? 'n/a' : navigator.userAgent}`
		]
			.filter((l) => l !== null)
			.join('\n');
	}

	async function copyDebug(error: unknown): Promise<void> {
		try {
			await navigator.clipboard.writeText(debugText(error));
			copied = true;
			setTimeout(() => {
				copied = false;
			}, 2000);
		} catch {
			// Clipboard API unavailable or permission denied.
		}
	}
</script>

<svelte:boundary onerror={report}>
	{@render children()}
	{#snippet failed(error: unknown, reset: () => void)}
		<div class="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center px-4">
			<div class="card w-full p-8 text-center">
				<div
					class="mx-auto flex size-12 items-center justify-center rounded-xl ring-1 ring-edge"
					style="background: color-mix(in srgb, var(--color-down) 14%, transparent)"
				>
					<TriangleAlert class="size-6 text-down" />
				</div>
				<h1 class="mt-5 text-xl font-semibold tracking-tight">The page crashed</h1>
				<p class="mt-2 break-words font-mono text-xs text-muted">{describe(error)}</p>
				<div class="mt-6 flex flex-wrap items-center justify-center gap-2">
					<button class="btn btn-primary" onclick={reset}
						><RotateCcw class="size-4" />Try again</button
					>
					<button
						class="btn"
						onclick={() => {
							location.reload();
						}}>Reload page</button
					>
					<button
						class="btn"
						onclick={() => {
							void copyDebug(error);
						}}
					>
						{#if copied}<Check class="size-4" />Copied{:else}<Copy class="size-4" />Copy debug info{/if}
					</button>
				</div>
			</div>
		</div>
	{/snippet}
</svelte:boundary>
