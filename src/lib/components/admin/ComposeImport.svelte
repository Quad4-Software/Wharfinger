<script lang="ts">
	import Modal from '$lib/components/admin/Modal.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import { api, ApiError, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';

	// Compose import: paste or upload a compose file, preview the
	// conversion plan (per-service app drafts plus loud unsupported
	// keys), then create the linked apps in one shot.
	interface Draft {
		name: string;
		source: { kind: string; url?: string };
		env: Record<string, string>;
		ports: { host: number; container: number; local?: boolean }[];
		healthcheck: Record<string, unknown>;
		unsupported: string[];
		notes: string[];
		error?: string;
	}
	interface Plan {
		project: string;
		services: Draft[];
		warnings: string[];
	}

	let {
		open = $bindable(false),
		agents = [],
		onimported
	}: {
		open?: boolean;
		agents?: { id: string; name: string }[];
		onimported?: () => unknown;
	} = $props();

	const EXAMPLE = 'services:\n  web:\n    image: ghcr.io/org/app:latest';

	let yaml = $state('');
	let agentId = $state('');
	let project = $state('');
	let plan = $state<Plan | null>(null);
	let busy = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);

	$effect(() => {
		if (!open) return;
		yaml = '';
		project = '';
		plan = null;
		agentId = agents.at(0)?.id ?? '';
	});

	async function pickFile(e: Event): Promise<void> {
		const f = (e.currentTarget as HTMLInputElement).files?.[0];
		if (!f) return;
		if (f.size > 256 * 1024) {
			toast('error', 'compose file over 256KB');
			return;
		}
		yaml = await f.text();
		plan = null;
	}

	function body(preview: boolean): Record<string, unknown> {
		return {
			compose: yaml,
			agentId,
			preview,
			...(project.trim() ? { project: project.trim() } : {})
		};
	}

	async function preview(): Promise<void> {
		if (!yaml.trim()) {
			toast('error', 'paste or upload a compose file first');
			return;
		}
		busy = true;
		try {
			const res = await api<{ plan: Plan }>('/deploy/apps/compose', {
				body: body(true)
			});
			plan = res.plan;
		} catch (err) {
			const p = err instanceof ApiError ? (err.data.plan as Plan | undefined) : undefined;
			plan = p ?? null;
			toast('error', errMessage(err, 'preview failed').slice(0, 400));
		} finally {
			busy = false;
		}
	}

	async function import_(): Promise<void> {
		busy = true;
		try {
			const res = await api<{ apps: { id: string; name: string }[] }>('/deploy/apps/compose', {
				body: body(false)
			});
			open = false;
			toast('success', `Imported ${res.apps.length} app(s)`);
			await onimported?.();
		} catch (err) {
			const p = err instanceof ApiError ? (err.data.plan as Plan | undefined) : undefined;
			if (p) plan = p;
			toast('error', errMessage(err, 'import failed').slice(0, 400));
		} finally {
			busy = false;
		}
	}
</script>

<Modal bind:open title="Import compose file" wide>
	<div class="space-y-4">
		<div class="grid gap-4 sm:grid-cols-2">
			<Field label="Target system" hint="Agent that runs every imported service" required>
				<select class="input" bind:value={agentId} required>
					{#each agents as a (a.id)}
						<option value={a.id}>{a.name}</option>
					{/each}
				</select>
			</Field>
			<Field label="Project name" hint="Defaults to the compose name key; prefixes app names">
				<input class="input" bind:value={project} placeholder="my-stack" />
			</Field>
		</div>

		<Field
			label="Compose YAML"
			hint="Services become linked apps under a shared group. Unsupported keys are listed, never dropped silently"
			required
		>
			<textarea
				class="input min-h-40 font-mono text-xs"
				bind:value={yaml}
				placeholder={EXAMPLE}
				oninput={() => (plan = null)}></textarea>
		</Field>
		<div class="flex items-center gap-2">
			<button type="button" class="btn" onclick={() => fileInput?.click()}> Choose file </button>
			<input
				bind:this={fileInput}
				type="file"
				accept=".yml,.yaml,text/yaml"
				class="hidden"
				onchange={pickFile}
			/>
		</div>

		{#if plan}
			<div class="space-y-2 rounded-lg border border-edge p-3" aria-live="polite">
				<p class="text-sm font-medium">
					Plan{plan.project ? ` for ${plan.project}` : ''}: {plan.services.length} service(s)
				</p>
				{#each plan.warnings as w (w)}
					<p class="text-xs text-degraded">{w}</p>
				{/each}
				{#each plan.services as svc (svc.name)}
					<div class="rounded-md border border-edge px-3 py-2 text-xs">
						<div class="flex items-center justify-between gap-2">
							<span class="font-semibold">{svc.name}</span>
							<span class="chip chip-muted">{svc.source.kind}</span>
						</div>
						<p class="mt-1 truncate text-faint">{svc.source.url ?? 'no source'}</p>
						{#if svc.error}
							<p class="mt-1 text-down-fg">{svc.error}</p>
						{/if}
						{#if svc.unsupported.length}
							<p class="mt-1 text-degraded">
								unsupported: {svc.unsupported.join(', ')}
							</p>
						{/if}
						{#each svc.notes as n (n)}
							<p class="mt-0.5 text-faint">{n}</p>
						{/each}
					</div>
				{/each}
			</div>
		{/if}

		<div class="flex justify-end gap-2 pt-1">
			<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
			<button type="button" class="btn" onclick={preview} disabled={busy || !agentId}>
				Preview
			</button>
			<button
				type="button"
				class="btn btn-primary"
				onclick={import_}
				disabled={busy || !agentId || !plan || plan.services.some((s) => s.error)}
			>
				Import {plan ? `${plan.services.length} app(s)` : ''}
			</button>
		</div>
	</div>
</Modal>
