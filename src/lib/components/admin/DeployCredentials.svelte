<script lang="ts">
	import { Copy, KeyRound, RotateCcw, Webhook } from '@lucide/svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import type { DeployApp } from '$lib/shared/deploy';
	import { api, ApiError, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';

	// Webhook URL, deploy key, and forge token for one app. Rotation
	// responses carry shown-once secrets up through onrotated; the
	// forge token PATCH reports a save through onsaved so the parent
	// reloads the app.
	const {
		app,
		secretBox = {},
		onrotated,
		onsaved
	}: {
		app: DeployApp;
		secretBox?: { webhook?: string; deployKeyPub?: string };
		onrotated: (secrets: { webhook?: string; deployKeyPub?: string }) => void;
		onsaved: () => void;
	} = $props();

	let forgeTokenText = $state('');

	async function rotate(what: 'webhook' | 'key'): Promise<void> {
		try {
			const res = await api<{ webhook?: string; deployKeyPub?: string }>(
				`/deploy/apps/${app.id}/rotate`,
				{ method: 'POST', body: { what } }
			);
			onrotated(res);
			toast('success', what === 'webhook' ? 'Webhook rotated' : 'Deploy key rotated');
		} catch (err) {
			toast('error', errMessage(err, 'rotate failed').slice(0, 400));
		}
	}

	async function saveForgeToken(): Promise<void> {
		try {
			await api(`/deploy/apps/${app.id}`, {
				method: 'PATCH',
				body: { forgeToken: forgeTokenText, expectedUpdatedAt: app.updatedAt }
			});
			forgeTokenText = '';
			toast('success', 'Forge token saved');
			onsaved();
		} catch (err) {
			toast('error', errMessage(err, 'token save failed').slice(0, 400));
			if (err instanceof ApiError && err.status === 409) onsaved();
		}
	}

	async function copy(text: string, label: string): Promise<void> {
		await navigator.clipboard.writeText(text).catch(() => undefined);
		toast('info', `${label} copied`);
	}
</script>

<div class="card p-4">
	<h2 class="mb-3 flex items-center gap-2 text-sm font-semibold">
		<Webhook class="size-4 text-faint" /> Webhook and keys
	</h2>
	{#if secretBox.webhook}
		<div class="mb-3 rounded-lg border border-edge bg-raised p-3">
			<p class="mb-1 text-xs text-faint">New webhook URL, shown once</p>
			<div class="flex items-center gap-2">
				<code class="min-w-0 flex-1 truncate font-mono text-xs">{secretBox.webhook}</code>
				<button
					class="btn btn-ghost btn-sm"
					onclick={() => copy(secretBox.webhook ?? '', 'Webhook')}
				>
					<Copy class="size-3.5" />
				</button>
			</div>
		</div>
	{:else}
		<p class="mb-3 text-xs text-muted">
			Webhook endpoint is configured{app.hasHookSecret ? ' with a signing secret' : ''}. The URL is
			only shown right after creation or rotation.
		</p>
	{/if}
	{#if secretBox.deployKeyPub}
		<div class="mb-3 rounded-lg border border-edge bg-raised p-3">
			<p class="mb-1 text-xs text-faint">Deploy key, add as a read-only deploy key on the repo</p>
			<div class="flex items-center gap-2">
				<code class="min-w-0 flex-1 truncate font-mono text-xs">{secretBox.deployKeyPub}</code>
				<button
					class="btn btn-ghost btn-sm"
					onclick={() => copy(secretBox.deployKeyPub ?? '', 'Deploy key')}
				>
					<Copy class="size-3.5" />
				</button>
			</div>
		</div>
	{/if}
	<div class="flex flex-wrap gap-2">
		<button class="btn btn-sm" onclick={() => rotate('webhook')}>
			<RotateCcw class="size-3.5" /> Rotate webhook
		</button>
		<button class="btn btn-sm" onclick={() => rotate('key')}>
			<KeyRound class="size-3.5" /> Rotate deploy key
		</button>
	</div>
	{#if app.source.kind === 'git'}
		<div class="mt-3 border-t border-edge pt-3">
			<Field
				label="Forge API token"
				hint={app.hasForgeToken
					? 'PAT or app token for commit-status posts; set. Enter a new one to replace, blank to clear'
					: 'PAT or app token for commit-status posts; sealed at rest, never echoed'}
			>
				<div class="flex gap-2">
					<input
						class="input flex-1 font-mono"
						type="password"
						bind:value={forgeTokenText}
						placeholder={app.hasForgeToken ? 'stored (hidden)' : 'glpat-... / ghp_...'}
						autocomplete="off"
					/>
					<button class="btn btn-sm" onclick={() => void saveForgeToken()}>
						{forgeTokenText ? 'Save' : 'Clear'}
					</button>
				</div>
			</Field>
		</div>
	{/if}
</div>
