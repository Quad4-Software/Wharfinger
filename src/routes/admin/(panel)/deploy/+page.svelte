<script lang="ts">
	import { onMount } from 'svelte';
	import { Plus, Rocket, GitBranch, Layers, FileInput } from '@lucide/svelte';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import DeployAppForm from '$lib/components/admin/DeployAppForm.svelte';
	import ComposeImport from '$lib/components/admin/ComposeImport.svelte';
	import type { DeployApp } from '$lib/shared/deploy';
	import type { Job } from '$lib/shared/jobs';
	import { adminHref, api, ApiError, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import { fmtDateTime } from '$lib/utils/format';

	let apps = $state<DeployApp[]>([]);
	let jobs = $state<Job[]>([]);
	let agents = $state<{ id: string; name: string }[]>([]);
	let loading = $state(true);
	let formOpen = $state(false);
	let importOpen = $state(false);
	let saving = $state(false);

	async function load(): Promise<void> {
		try {
			const [a, j, ag] = await Promise.all([
				api<{ apps: DeployApp[] }>('/deploy/apps'),
				api<{ jobs: Job[] }>('/deploy/jobs'),
				api<{ agents: { id: string; name: string }[] }>('/agents').catch(() => ({
					agents: [] as { id: string; name: string }[]
				}))
			]);
			apps = a.apps;
			jobs = j.jobs.slice(0, 12);
			agents = ag.agents;
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'load failed');
		} finally {
			loading = false;
		}
	}

	onMount(load);

	// Returns the response so DeployAppForm can sync group membership
	// against the new app id.
	async function create(body: Record<string, unknown>): Promise<unknown> {
		saving = true;
		try {
			const res = await api<{ webhook: string; deployKeyPub: string }>('/deploy/apps', {
				method: 'POST',
				body
			});
			formOpen = false;
			toast('success', 'Application created');
			await navigator.clipboard.writeText(res.webhook).catch(() => undefined);
			toast('info', 'Webhook URL copied; store the deploy key shown on the app page');
			await load();
			return res;
		} catch (err) {
			toast('error', errMessage(err, 'create failed').slice(0, 400));
			return null;
		} finally {
			saving = false;
		}
	}

	function jobTone(status: string): string {
		if (status === 'succeeded') return 'chip-on';
		if (status === 'failed' || status === 'rolled_back') return 'chip-down';
		if (status === 'unknown') return 'chip-warn';
		return 'chip-muted';
	}
</script>

<PageHeader
	title="Deployments"
	description="Git, image, static, and compose workloads on your systems"
>
	<button class="btn" onclick={() => (importOpen = true)} disabled={saving}>
		<FileInput class="size-4" /> Import compose
	</button>
	<button class="btn btn-primary" onclick={() => (formOpen = true)} disabled={saving}>
		<Plus class="size-4" /> New app
	</button>
</PageHeader>

{#if loading}
	<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
		{#each [0, 1, 2] as i (i)}
			<div class="card h-28 animate-pulse"></div>
		{/each}
	</div>
{:else if apps.length === 0}
	<div class="card p-10 text-center">
		<Rocket class="mx-auto mb-3 size-8 text-faint" />
		<p class="text-muted">No applications yet.</p>
		<p class="mt-1 text-xs text-faint">
			Deploy a git repo, image, static site, or compose file to any connected system.
		</p>
		<button class="btn btn-primary mt-4" onclick={() => (formOpen = true)}>
			<Plus class="size-4" /> Create one
		</button>
	</div>
{:else}
	<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
		{#each apps as app (app.id)}
			<a
				href={adminHref(`/deploy/${app.id}`)}
				class="card block p-4 transition-colors hover:border-edge-hi"
			>
				<div class="flex items-center justify-between gap-2">
					<span class="truncate text-sm font-semibold">{app.name}</span>
					<span class="flex shrink-0 items-center gap-1.5">
						{#if app.previewPr != null}
							<span class="chip chip-warn">PR #{app.previewPr}</span>
						{/if}
						<span class="chip chip-muted">{app.runtime}</span>
					</span>
				</div>
				<div class="mt-2 flex items-center gap-2 text-xs text-muted">
					<GitBranch class="size-3.5 shrink-0 text-faint" />
					<span class="truncate">{app.source.kind} · {app.source.url ?? 'inline'}</span>
				</div>
				<div class="mt-1.5 flex items-center gap-2 text-xs text-faint">
					<Layers class="size-3.5 shrink-0" />
					<span class="truncate">
						{app.domains.length ? app.domains.join(', ') : 'no domains'} · agent {app.agentId.slice(
							0,
							8
						)}
					</span>
				</div>
			</a>
		{/each}
	</div>
{/if}

{#if !loading && jobs.length}
	<h2 class="mb-2 mt-8 text-sm font-semibold text-muted">Recent jobs</h2>
	<div class="card divide-y divide-edge">
		{#each jobs as job (job.id)}
			<div class="flex items-center gap-3 px-4 py-2.5">
				<span class="chip {jobTone(job.status)}">{job.status}</span>
				<span class="min-w-0 flex-1 truncate text-sm">{job.jobKey}</span>
				<span class="shrink-0 text-xs text-faint">
					{job.kind} · {fmtDateTime(new Date(job.createdAt).toISOString())}
				</span>
			</div>
		{/each}
	</div>
{/if}

<DeployAppForm bind:open={formOpen} {agents} onsave={create} />
<ComposeImport bind:open={importOpen} {agents} onimported={load} />
