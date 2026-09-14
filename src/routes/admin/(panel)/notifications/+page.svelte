<script lang="ts">
	import { onMount } from 'svelte';
	import { Bell, Pencil, Plus, Send, Trash } from '@lucide/svelte';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import SectionChip from '$lib/components/admin/SectionChip.svelte';
	import SaveBar from '$lib/components/admin/SaveBar.svelte';
	import ConfirmDialog from '$lib/components/admin/ConfirmDialog.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import TargetEditor from '$lib/components/admin/TargetEditor.svelte';
	import type { TargetDraft } from '$lib/shared/drafts';
	import { api, ApiError, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import { relativeTime } from '$lib/utils/format';

	interface NotifSection {
		enabled?: boolean;
		cooldown_seconds?: number;
		timeout_ms?: number;
		retries?: number;
		targets?: TargetDraft[];
	}
	interface SectionView {
		value?: NotifSection;
		overridden: boolean;
		updatedAt: number | null;
	}
	interface LogEntry {
		id: number;
		target: string;
		kind: string;
		event: string;
		serviceId: string | null;
		ok: boolean;
		status: number | null;
		error: string | null;
		at: number;
	}
	interface SubRow {
		id: number;
		url: string;
		services: string[];
		confirmed: boolean;
		createdAt: number;
		disabled: boolean;
	}

	let loaded = $state<NotifSection>({});
	let draft = $state<NotifSection>({});
	let overridden = $state(false);
	let updatedAt = $state<number | null>(null);
	let services = $state<{ id: string; name: string }[]>([]);
	let logEntries = $state<LogEntry[]>([]);
	let loading = $state(true);
	let saving = $state(false);
	let editorOpen = $state(false);
	let editing = $state<TargetDraft | null>(null);
	let editingIdx = $state(-1);
	let deleteIdx = $state(-1);
	let deleteOpen = $state(false);
	let testing = $state<string | null>(null);
	let subs = $state<SubRow[]>([]);

	const targets = $derived(draft.targets ?? []);
	const dirty = $derived(JSON.stringify(draft) !== JSON.stringify(loaded));

	async function load(): Promise<void> {
		try {
			const [sec, svc, log, subRes] = await Promise.all([
				api<SectionView>('/sections/notifications'),
				api<{ value: { id: string; name: string }[] }>('/sections/services'),
				api<{ entries: LogEntry[] }>('/notifications/log'),
				api<{ subscribers: SubRow[] }>('/subscribers').catch(() => ({ subscribers: [] }))
			]);
			loaded = sec.value ?? {};
			draft = structuredClone(loaded);
			overridden = sec.overridden;
			updatedAt = sec.updatedAt;
			services = Array.isArray(svc.value) ? svc.value : [];
			logEntries = log.entries;
			subs = subRes.subscribers;
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'load failed');
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function onEditorSave(t: TargetDraft): void {
		const list = [...targets];
		if (editingIdx === -1) list.push(t);
		else list[editingIdx] = t;
		draft = { ...draft, targets: list };
		toast('info', 'Target saved; apply with Save');
	}

	async function save(): Promise<void> {
		saving = true;
		try {
			await api('/sections/notifications', {
				method: 'PUT',
				body: { value: draft, expected: updatedAt }
			});
			toast('success', 'Notification settings applied');
			await load();
		} catch (err) {
			toast('error', errMessage(err, 'save failed').slice(0, 400));
		} finally {
			saving = false;
		}
	}

	async function test(t: TargetDraft): Promise<void> {
		testing = t.name;
		try {
			await api('/notifications/test', { body: { target: t.name } });
			toast('success', `Test sent to ${t.name}`);
			const log = await api<{ entries: LogEntry[] }>('/notifications/log');
			logEntries = log.entries;
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'test failed');
			const log = await api<{ entries: LogEntry[] }>('/notifications/log').catch(() => null);
			if (log) logEntries = log.entries;
		} finally {
			testing = null;
		}
	}

	const lastFor = $derived((name: string) => logEntries.find((e) => e.target === name));

	async function removeSub(s: SubRow): Promise<void> {
		try {
			await api(`/subscribers?id=${s.id}`, { method: 'DELETE' });
			subs = subs.filter((x) => x.id !== s.id);
			toast('success', 'Subscriber removed');
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'delete failed');
		}
	}
</script>

<PageHeader
	title="Notifications"
	description="Push alerts on status changes: ntfy, UnifiedPush, webhooks, Slack, Discord, Teams, Telegram, Gotify, Pushover"
>
	<SectionChip section="notifications" {overridden} onreset={load} />
	<button
		class="btn btn-primary"
		onclick={() => {
			editing = null;
			editingIdx = -1;
			editorOpen = true;
		}}
	>
		<Plus class="size-4" /> Add target
	</button>
</PageHeader>

{#if loading}
	<div class="space-y-6">
		<div class="card h-36 animate-pulse"></div>
		<div class="card h-48 animate-pulse"></div>
	</div>
{:else}
	<section class="card p-5">
		<h2 class="mb-4 text-sm font-semibold">Delivery settings</h2>
		<div class="grid gap-3 sm:grid-cols-4">
			<Field label="Enabled">
				<select
					class="input"
					value={draft.enabled === false ? 'off' : 'on'}
					onchange={(e) => (draft = { ...draft, enabled: e.currentTarget.value === 'on' })}
				>
					<option value="on">on</option>
					<option value="off">off</option>
				</select>
			</Field>
			<Field label="Cooldown (s)" hint="Min gap per target/service/event.">
				<input
					class="input"
					type="number"
					min="0"
					value={draft.cooldown_seconds ?? 300}
					oninput={(e) => (draft = { ...draft, cooldown_seconds: Number(e.currentTarget.value) })}
				/>
			</Field>
			<Field label="Timeout (ms)">
				<input
					class="input"
					type="number"
					min="500"
					value={draft.timeout_ms ?? 8000}
					oninput={(e) => (draft = { ...draft, timeout_ms: Number(e.currentTarget.value) })}
				/>
			</Field>
			<Field label="Retries">
				<input
					class="input"
					type="number"
					min="0"
					max="5"
					value={draft.retries ?? 1}
					oninput={(e) => (draft = { ...draft, retries: Number(e.currentTarget.value) })}
				/>
			</Field>
		</div>
	</section>

	<section class="mt-6">
		<h2 class="mb-3 text-sm font-semibold">Targets</h2>
		{#if targets.length === 0}
			<div class="card p-10 text-center">
				<Bell class="mx-auto mb-3 size-8 text-faint" />
				<p class="text-muted">No targets. Add an ntfy topic, chat webhook, or push endpoint.</p>
			</div>
		{:else}
			<div class="card divide-y divide-edge">
				{#each targets as t, i (t.name)}
					{@const last = lastFor(t.name)}
					<div class="flex items-center gap-3 px-4 py-3">
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span class="text-sm font-medium">{t.name}</span>
								<span class="chip">{t.type}</span>
								{#if !t.enabled}<span class="chip">disabled</span>{/if}
								{#if last}
									<span
										class="text-xs {last.ok ? 'text-up-fg' : 'text-down-fg'}"
										title={last.error ?? ''}
									>
										last {last.ok ? 'ok' : 'failed'}
										{relativeTime(last.at)}
									</span>
								{/if}
							</div>
							<p class="mt-0.5 truncate font-mono text-xs text-faint">
								{t.url ??
									(t.type === 'telegram'
										? 'api.telegram.org'
										: t.type === 'pushover'
											? 'api.pushover.net'
											: '')} · {t.events.join(', ')} · {t.services.includes('all')
									? 'all'
									: t.services.join(', ')}
							</p>
						</div>
						<div class="flex shrink-0 items-center gap-1">
							<button
								class="btn btn-ghost btn-sm"
								title="Send test notification"
								disabled={testing === t.name}
								onclick={() => test(t)}
							>
								<Send class="size-3.5" />
							</button>
							<button
								class="btn btn-ghost btn-sm"
								title="Edit"
								onclick={() => {
									editing = t;
									editingIdx = i;
									editorOpen = true;
								}}
							>
								<Pencil class="size-3.5" />
							</button>
							<button
								class="btn btn-ghost btn-sm text-down-fg"
								title="Delete"
								onclick={() => {
									deleteIdx = i;
									deleteOpen = true;
								}}
							>
								<Trash class="size-3.5" />
							</button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</section>

	<section class="mt-6">
		<h2 class="mb-1 text-sm font-semibold">Webhook subscribers</h2>
		<p class="mb-3 text-xs text-faint">
			Public endpoints that subscribed on the status page (double opt-in, HMAC-signed).
		</p>
		<div class="card divide-y divide-edge">
			{#each subs as s (s.id)}
				<div class="flex items-center gap-3 px-4 py-2.5 text-xs">
					<div class="min-w-0 flex-1">
						<span class="block truncate font-mono text-muted">{s.url}</span>
						<span class="text-faint">
							{s.services.join(', ')} · added {relativeTime(s.createdAt)}
						</span>
					</div>
					{#if s.disabled}
						<span class="chip border-down/50 text-down-fg">unsubscribed</span>
					{:else if !s.confirmed}
						<span class="chip">pending</span>
					{:else}
						<span class="chip chip-on">confirmed</span>
					{/if}
					<button
						class="btn btn-ghost btn-sm text-down-fg"
						title="Remove"
						onclick={() => void removeSub(s)}
					>
						<Trash class="size-3.5" />
					</button>
				</div>
			{:else}
				<p class="px-4 py-3 text-xs text-faint">No subscribers yet.</p>
			{/each}
		</div>
	</section>

	{#if logEntries.length > 0}
		<section class="mt-6">
			<h2 class="mb-3 text-sm font-semibold">Recent deliveries</h2>
			<div class="card divide-y divide-edge">
				{#each logEntries.slice(0, 15) as e (e.id)}
					<div class="flex items-center justify-between gap-3 px-4 py-2.5 text-xs">
						<span class="truncate text-muted">
							{e.target} · {e.event}{e.serviceId ? ` · ${e.serviceId}` : ''}
						</span>
						<span class={e.ok ? 'text-up-fg' : 'text-down-fg'} title={e.error ?? ''}>
							{e.ok ? 'sent' : `failed${e.status ? ` (${e.status})` : ''}`} · {relativeTime(e.at)}
						</span>
					</div>
				{/each}
			</div>
		</section>
	{/if}
{/if}

<SaveBar {dirty} {saving} onsave={save} ondiscard={() => (draft = structuredClone(loaded))} />

<TargetEditor
	bind:open={editorOpen}
	target={editing}
	existingNames={targets.map((t) => t.name)}
	{services}
	onsave={onEditorSave}
/>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Delete target?"
	description={`"${targets[deleteIdx]?.name ?? 'This target'}" will stop receiving notifications.`}
	confirmLabel="Delete"
	danger
	onconfirm={() => {
		draft = { ...draft, targets: targets.filter((_, i) => i !== deleteIdx) };
		deleteIdx = -1;
	}}
/>
