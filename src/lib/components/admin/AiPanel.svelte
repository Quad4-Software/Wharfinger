<script lang="ts">
	import { Bot, Sparkles } from '@lucide/svelte';
	import ConfirmDialog from '$lib/components/admin/ConfirmDialog.svelte';
	import { api, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';

	interface Suggestion {
		kind: string;
		label: string;
		reason: string;
		danger: boolean;
		call: { method: 'POST'; path: string; body: Record<string, unknown> } | null;
	}

	const {
		serviceId = null,
		incidentId = null
	}: { serviceId?: string | null; incidentId?: string | null } = $props();

	let question = $state('');
	let answer = $state<{ text: string; sources: string[] } | null>(null);
	let suggestions = $state<Suggestion[] | null>(null);
	let busy = $state<'ask' | 'suggest' | null>(null);
	let confirmIdx = $state(-1);
	let confirmOpen = $state(false);

	$effect(() => {
		if (!confirmOpen) confirmIdx = -1;
	});
	let enabled = $state<boolean | null>(null);

	async function ask(): Promise<void> {
		if (!question.trim()) return;
		busy = 'ask';
		try {
			const r = await api<{ answer: string; sources: string[] }>('/ai/ask', {
				method: 'POST',
				body: { question: question.trim(), serviceId, incidentId }
			});
			enabled = true;
			answer = { text: r.answer, sources: r.sources };
		} catch (err) {
			const msg = errMessage(err);
			if (msg.includes('not enabled')) enabled = false;
			toast('error', msg);
		} finally {
			busy = null;
		}
	}

	async function suggest(): Promise<void> {
		busy = 'suggest';
		try {
			const r = await api<{ suggestions: Suggestion[] }>('/ai/suggest', {
				method: 'POST',
				body: { serviceId, incidentId }
			});
			enabled = true;
			suggestions = r.suggestions;
		} catch (err) {
			const msg = errMessage(err);
			if (msg.includes('not enabled')) enabled = false;
			toast('error', msg);
		} finally {
			busy = null;
		}
	}

	async function runSuggestion(s: Suggestion): Promise<void> {
		if (!s.call) return;
		try {
			await api(s.call.path, { method: s.call.method, body: s.call.body });
			toast('success', `${s.label} queued`);
		} catch (err) {
			toast('error', errMessage(err));
		}
	}
</script>

<div class="card p-4">
	<h2 class="mb-2 flex items-center gap-1.5 text-sm font-medium text-muted">
		<Bot class="size-4" /> Assistant
		<span class="text-[10px] font-normal text-faint">generated; verify before acting</span>
	</h2>
	{#if enabled === false}
		<p class="text-xs text-faint">
			AI is off. Set <code class="font-mono">[ai] enabled = true</code> with a provider to use it.
		</p>
	{:else}
		<div class="flex flex-col gap-2">
			<textarea
				class="input h-16 text-xs"
				bind:value={question}
				placeholder="Ask about the current status, incidents, or agents..."
				maxlength="2000"></textarea>
			<div class="flex gap-2">
				<button
					class="btn btn-primary btn-sm"
					disabled={busy !== null || !question.trim()}
					onclick={ask}
				>
					{busy === 'ask' ? 'Asking...' : 'Ask'}
				</button>
				<button class="btn btn-ghost btn-sm" disabled={busy !== null} onclick={suggest}>
					<Sparkles class="size-3.5" />
					{busy === 'suggest' ? 'Thinking...' : 'Suggest actions'}
				</button>
			</div>
		</div>

		{#if answer}
			<div class="mt-3 rounded-md border border-edge bg-bg p-3">
				<p class="whitespace-pre-wrap text-xs leading-relaxed text-fg">{answer.text}</p>
				<p class="mt-2 text-[10px] text-faint">sources: {answer.sources.join(', ')}</p>
			</div>
		{/if}

		{#if suggestions !== null}
			<div class="mt-3 space-y-2">
				{#if suggestions.length === 0}
					<p class="text-xs text-faint">No actions suggested.</p>
				{/if}
				{#each suggestions as s, i (i)}
					<div class="flex items-start justify-between gap-2 rounded-md border border-edge p-2.5">
						<div class="min-w-0">
							<p class="text-xs font-medium text-fg">{s.label}</p>
							{#if s.reason}
								<p class="mt-0.5 text-[11px] text-faint">{s.reason}</p>
							{/if}
						</div>
						{#if s.call}
							<button
								class="btn btn-sm shrink-0 {s.danger ? 'btn-danger' : 'btn'}"
								onclick={() => {
									confirmIdx = i;
									confirmOpen = true;
								}}
							>
								Run
							</button>
						{:else}
							<span class="shrink-0 text-[10px] text-faint">manual step</span>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>

{#if confirmIdx >= 0 && suggestions?.[confirmIdx]}
	{@const sel = suggestions[confirmIdx]}
	<ConfirmDialog
		bind:open={confirmOpen}
		title="Run suggested action?"
		description="{sel.label}{sel.reason
			? ` — ${sel.reason}`
			: ''}. This calls the real admin endpoint and is audit-logged."
		confirmLabel="Run"
		danger={sel.danger}
		onconfirm={() => {
			confirmOpen = false;
			void runSuggestion(sel);
		}}
	/>
{/if}
