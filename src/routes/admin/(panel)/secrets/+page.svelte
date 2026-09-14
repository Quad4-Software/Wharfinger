<script lang="ts">
	import { onMount } from 'svelte';
	import { Copy, Eye, KeyRound, Pencil, Plus, Trash } from '@lucide/svelte';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import Modal from '$lib/components/admin/Modal.svelte';
	import ConfirmDialog from '$lib/components/admin/ConfirmDialog.svelte';
	import { api, ApiError, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import { fmtDateTime } from '$lib/utils/format';
	import type { SecretSetInfo } from '$lib/shared/groups';

	let sets = $state<SecretSetInfo[]>([]);
	let loading = $state(true);
	let busy = $state(false);

	let editTarget = $state<SecretSetInfo | null>(null);
	let editOpen = $state(false);
	let name = $state('');
	let entriesText = $state('');

	let deleteTarget = $state<SecretSetInfo | null>(null);
	let deleteOpen = $state(false);

	let revealTarget = $state<{ set: SecretSetInfo; key: string } | null>(null);
	let revealConfirmOpen = $state(false);
	let revealed = $state<{ set: string; key: string; value: string } | null>(null);
	let revealOpen = $state(false);

	async function load(): Promise<void> {
		try {
			const r = await api<{ sets: SecretSetInfo[] }>('/secrets');
			sets = r.sets;
		} catch (err) {
			toast('error', errMessage(err, 'load failed'));
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function openEdit(s: SecretSetInfo | null): void {
		editTarget = s;
		name = s?.name ?? '';
		entriesText = '';
		editOpen = true;
	}

	// KEY=VALUE lines; blank lines and comments are skipped. A malformed
	// line returns null so the caller can surface one error.
	function parseEntries(text: string): Record<string, string> | null {
		const out: Record<string, string> = {};
		for (const raw of text.split('\n')) {
			const line = raw.trim();
			if (!line || line.startsWith('#')) continue;
			const eq = line.indexOf('=');
			if (eq < 1) return null;
			out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
		}
		return out;
	}

	async function save(): Promise<void> {
		const hasText = entriesText.trim().length > 0;
		const entries = hasText ? parseEntries(entriesText) : null;
		if (hasText && entries === null) {
			toast('error', 'entries must be KEY=VALUE lines');
			return;
		}
		busy = true;
		try {
			if (editTarget) {
				// Empty textarea means name-only edit; current keys are kept.
				const body: Record<string, unknown> = { name: name.trim() };
				if (entries !== null) body.entries = entries;
				await api(`/secrets/${editTarget.id}`, { method: 'PUT', body });
				toast('success', 'Secret set updated');
			} else {
				await api('/secrets', { body: { name: name.trim(), entries: entries ?? {} } });
				toast('success', 'Secret set created');
			}
			editOpen = false;
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'save failed');
		} finally {
			busy = false;
		}
	}

	async function reveal(): Promise<void> {
		if (!revealTarget) return;
		busy = true;
		try {
			const r = await api<{ value: string }>(`/secrets/${revealTarget.set.id}/reveal`, {
				body: { key: revealTarget.key }
			});
			revealed = { set: revealTarget.set.name, key: revealTarget.key, value: r.value };
			revealConfirmOpen = false;
			revealOpen = true;
		} catch (err) {
			toast('error', errMessage(err, 'reveal failed'));
		} finally {
			busy = false;
		}
	}

	async function copy(text: string): Promise<void> {
		await navigator.clipboard.writeText(text).catch(() => undefined);
		toast('info', 'Value copied');
	}

	async function remove(): Promise<void> {
		if (!deleteTarget) return;
		busy = true;
		try {
			await api(`/secrets/${deleteTarget.id}`, { method: 'DELETE' });
			toast('success', 'Secret set deleted');
			deleteOpen = false;
			await load();
		} catch (err) {
			toast('error', errMessage(err, 'delete failed'));
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader
	title="Secrets"
	description="Sealed key-value sets; values are never listed, only revealed per key"
>
	<button
		class="btn btn-primary"
		onclick={() => {
			openEdit(null);
		}}
	>
		<Plus class="size-4" /> New set
	</button>
</PageHeader>

{#if loading}
	<div class="space-y-3" aria-busy="true">
		<div class="card h-24 animate-pulse"></div>
		<div class="card h-24 animate-pulse"></div>
	</div>
{:else if sets.length === 0}
	<div class="card p-10 text-center">
		<KeyRound class="mx-auto mb-3 size-8 text-faint" />
		<p class="text-muted">No secret sets yet.</p>
		<p class="mt-1 text-xs text-faint">
			Sealed key-value maps stored with the data key; individual values are revealed on demand.
		</p>
		<button
			class="btn btn-primary mt-4"
			onclick={() => {
				openEdit(null);
			}}
		>
			<Plus class="size-4" /> Create one
		</button>
	</div>
{:else}
	<div class="space-y-3">
		{#each sets as s (s.id)}
			<div class="card p-4">
				<div class="flex items-center justify-between gap-2">
					<span class="min-w-0 truncate text-sm font-semibold">{s.name}</span>
					<div class="flex shrink-0 items-center gap-1">
						<span class="mr-1 text-xs text-faint"
							>updated {fmtDateTime(new Date(s.updatedAt).toISOString())}</span
						>
						<button
							class="btn btn-ghost btn-sm"
							aria-label="Edit {s.name}"
							onclick={() => {
								openEdit(s);
							}}
						>
							<Pencil class="size-3.5" />
						</button>
						<button
							class="btn btn-ghost btn-sm text-down-fg"
							aria-label="Delete {s.name}"
							onclick={() => {
								deleteTarget = s;
								deleteOpen = true;
							}}
						>
							<Trash class="size-3.5" />
						</button>
					</div>
				</div>
				<div class="mt-2 flex flex-wrap gap-1.5">
					{#each s.keys as k (k)}
						<span class="chip flex items-center gap-1.5 font-mono text-xs">
							{k}
							<button
								type="button"
								class="text-faint transition-colors hover:text-fg"
								aria-label="Reveal {k}"
								onclick={() => {
									revealTarget = { set: s, key: k };
									revealConfirmOpen = true;
								}}
							>
								<Eye class="size-3.5" />
							</button>
						</span>
					{:else}
						<span class="text-xs text-faint">No keys</span>
					{/each}
				</div>
			</div>
		{/each}
	</div>
{/if}

<Modal bind:open={editOpen} title={editTarget ? `Edit ${editTarget.name}` : 'New secret set'} wide>
	<form
		class="space-y-4"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<Field label="Name" required>
			<input
				class="input"
				bind:value={name}
				placeholder="registry-credentials"
				required
				maxlength="64"
			/>
		</Field>
		<Field
			label="Entries"
			hint={editTarget
				? 'KEY=VALUE lines replace the whole set; leave empty to keep current keys'
				: 'One KEY=VALUE per line'}
		>
			<textarea
				class="input min-h-32 font-mono text-xs"
				bind:value={entriesText}
				placeholder={editTarget
					? editTarget.keys.map((k) => `${k}=`).join('\n') || 'KEY=value'
					: 'KEY=value'}
				spellcheck="false"></textarea>
		</Field>
		<div class="flex justify-end gap-2">
			<button type="button" class="btn" onclick={() => (editOpen = false)}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={busy || !name.trim()}>
				{editTarget ? 'Save' : 'Create'}
			</button>
		</div>
	</form>
</Modal>

<ConfirmDialog
	bind:open={revealConfirmOpen}
	title="Reveal secret?"
	description={`The value of ${revealTarget?.key ?? 'this key'} in "${revealTarget?.set.name ?? ''}" will be shown once. The action is audited.`}
	confirmLabel="Reveal"
	onconfirm={() => void reveal()}
/>

<Modal
	bind:open={revealOpen}
	title={revealed ? `${revealed.set} / ${revealed.key}` : 'Secret value'}
>
	{#if revealed}
		<div class="space-y-4">
			<code
				class="block max-h-48 overflow-y-auto break-all rounded-lg border border-edge bg-raised p-3 font-mono text-xs"
				>{revealed.value}</code
			>
			<div class="flex justify-end gap-2">
				<button
					type="button"
					class="btn"
					onclick={() => {
						void copy(revealed?.value ?? '');
					}}
				>
					<Copy class="size-4" /> Copy
				</button>
				<button
					type="button"
					class="btn btn-primary"
					onclick={() => {
						revealOpen = false;
						revealed = null;
					}}
				>
					Done
				</button>
			</div>
		</div>
	{/if}
</Modal>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Delete secret set?"
	description={`"${deleteTarget?.name ?? 'This set'}" and all its keys will be removed permanently.`}
	confirmLabel="Delete"
	danger
	onconfirm={() => void remove()}
/>
