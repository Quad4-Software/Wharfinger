<script lang="ts">
	import { onMount } from 'svelte';
	import { Copy, Eye, KeyRound, Pencil, Plus, RotateCcwClock, Trash } from '@lucide/svelte';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import Modal from '$lib/components/admin/Modal.svelte';
	import ConfirmDialog from '$lib/components/admin/ConfirmDialog.svelte';
	import { api, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import { fmtDateTime, relativeTime } from '$lib/utils/format';
	import type { SecretSetInfo, SecretSetVersionInfo } from '$lib/shared/groups';

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

	let historyTarget = $state<SecretSetInfo | null>(null);
	let historyOpen = $state(false);
	let historyLoading = $state(false);
	let versions = $state<SecretSetVersionInfo[]>([]);

	let restoreTarget = $state<{ set: SecretSetInfo; version: number } | null>(null);
	let restoreConfirmOpen = $state(false);

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
			toast('error', errMessage(err, 'save failed'));
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

	async function openHistory(s: SecretSetInfo): Promise<void> {
		historyTarget = s;
		historyOpen = true;
		historyLoading = true;
		try {
			const r = await api<{ versions: SecretSetVersionInfo[] }>(`/secrets/${s.id}/versions`);
			versions = r.versions;
		} catch (err) {
			toast('error', errMessage(err, 'could not load version history'));
			historyOpen = false;
		} finally {
			historyLoading = false;
		}
	}

	async function restore(): Promise<void> {
		if (!restoreTarget) return;
		busy = true;
		try {
			await api(`/secrets/${restoreTarget.set.id}/versions`, {
				body: { version: restoreTarget.version }
			});
			toast('success', `Restored version ${restoreTarget.version}`);
			restoreConfirmOpen = false;
			await load();
			if (historyTarget) await openHistory(historyTarget);
		} catch (err) {
			toast('error', errMessage(err, 'restore failed'));
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
	description="Sealed key-value sets. Values are never listed, only revealed per key."
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
			Sealed key-value maps stored with the data key. Individual values are revealed on demand.
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
							>updated {fmtDateTime(new Date(s.updatedAt).toISOString())}{s.updatedBy
								? ` by ${s.updatedBy}`
								: ''}</span
						>
						<button
							class="btn btn-ghost btn-sm"
							aria-label="History of {s.name}"
							onclick={() => {
								void openHistory(s);
							}}
						>
							<RotateCcwClock class="size-3.5" />
						</button>
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
				? 'KEY=VALUE lines replace the whole set. Leave empty to keep current keys.'
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

<Modal bind:open={historyOpen} title={`History: ${historyTarget?.name ?? ''}`} wide>
	{#if historyLoading}
		<p class="py-6 text-center text-sm text-faint">Loading versions...</p>
	{:else if versions.length === 0}
		<p class="py-6 text-center text-sm text-faint">No versions yet.</p>
	{:else}
		<ul class="divide-y divide-edge/60">
			{#each versions as v (v.version)}
				<li class="flex flex-wrap items-center gap-2 py-2.5 text-xs">
					<span class="font-mono font-semibold">v{v.version}</span>
					<span class="text-muted">{relativeTime(v.createdAt)}</span>
					<span class="text-faint">{v.actor ?? 'unknown'}</span>
					<span class="flex min-w-0 flex-wrap gap-1">
						{#each v.changedKeys as k (k)}
							<span class="chip font-mono text-[0.65rem]">{k}</span>
						{:else}
							<span class="text-faint">no key changes</span>
						{/each}
					</span>
					<button
						class="btn btn-ghost btn-sm ml-auto shrink-0"
						disabled={busy}
						onclick={() => {
							if (!historyTarget) return;
							restoreTarget = { set: historyTarget, version: v.version };
							restoreConfirmOpen = true;
						}}
					>
						Restore
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</Modal>

<ConfirmDialog
	bind:open={restoreConfirmOpen}
	title={`Restore version ${restoreTarget?.version ?? ''}?`}
	description={`"${restoreTarget?.set.name ?? 'This set'}" will be overwritten with version ${restoreTarget?.version ?? ''}. Current values are versioned first, nothing is lost.`}
	confirmLabel="Restore"
	onconfirm={() => void restore()}
/>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Delete secret set?"
	description={`"${deleteTarget?.name ?? 'This set'}" and all its keys will be removed permanently.`}
	confirmLabel="Delete"
	danger
	onconfirm={() => void remove()}
/>
