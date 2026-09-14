<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		Copy,
		KeyRound,
		Pencil,
		Play,
		RefreshCw,
		Rocket,
		RotateCcw,
		ScanSearch,
		ShieldCheck,
		Trash,
		Webhook
	} from '@lucide/svelte';
	import { page } from '$app/state';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import StatTile from '$lib/components/admin/StatTile.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import ConfirmDialog from '$lib/components/admin/ConfirmDialog.svelte';
	import DeployAppForm from '$lib/components/admin/DeployAppForm.svelte';
	import type { DeployApp, DeployRelease } from '$lib/shared/deploy';
	import type { Job } from '$lib/shared/jobs';
	import type { Recommendation, ScanFinding, ScanReport } from '$lib/shared/scan';
	import { api, ApiError, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import { fmtDateTime } from '$lib/utils/format';

	const appId = $derived(page.params.id ?? '');

	let app = $state<DeployApp | null>(null);
	let live = $state<DeployRelease | null>(null);
	let releases = $state<DeployRelease[]>([]);
	let jobs = $state<Job[]>([]);
	let agents = $state<{ id: string; name: string }[]>([]);
	let loading = $state(true);
	let deploying = $state(false);
	let editOpen = $state(false);
	let deleteOpen = $state(false);
	let envText = $state('');
	let envDirty = $state(false);
	let envSaving = $state(false);
	let secretBox = $state<{ webhook?: string; deployKeyPub?: string }>({});
	let scanLatest = $state<ScanReport | null>(null);
	let scanFindings = $state<ScanFinding[]>([]);
	let recs = $state<Recommendation[]>([]);
	let scanDenied = $state(false);
	let scanning = $state(false);
	let findingsOpen = $state(false);
	let recBusy = $state<string | null>(null);

	const agentName = $derived(agents.find((a) => a.id === app?.agentId)?.name ?? app?.agentId ?? '');
	const appJobs = $derived(
		jobs
			.filter(
				(j) => j.jobKey.startsWith(`deploy:${appId}:`) || j.jobKey.startsWith(`scan:${appId}:`)
			)
			.slice(0, 8)
	);
	const canScanManage = $derived(
		((page.data.perms as string[] | undefined) ?? []).includes('scan.manage')
	);

	let poll: ReturnType<typeof setInterval> | undefined;

	async function load(): Promise<void> {
		try {
			const [d, j] = await Promise.all([
				api<{ app: DeployApp; live: DeployRelease | null; releases: DeployRelease[] }>(
					`/deploy/apps/${appId}`
				),
				api<{ jobs: Job[] }>('/deploy/jobs')
			]);
			app = d.app;
			live = d.live;
			releases = d.releases;
			jobs = j.jobs;
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'load failed');
		} finally {
			loading = false;
		}
		await loadScan();
	}

	async function loadScan(): Promise<void> {
		try {
			const [r, rec] = await Promise.all([
				api<{ reports: ScanReport[]; latest: ScanReport | null }>(
					`/scan/reports?appId=${appId}&limit=10`
				),
				api<{ recommendations: Recommendation[] }>(`/scan/recommendations?appId=${appId}`)
			]);
			recs = rec.recommendations;
			const latest = r.latest;
			if (latest?.status === 'done' && latest.id !== scanLatest?.id) {
				const detail = await api<{ findings: ScanFinding[] }>(
					`/scan/reports/${latest.id}?limit=200`
				);
				scanFindings = detail.findings;
			} else if (latest?.status !== 'done') {
				scanFindings = [];
			}
			scanLatest = latest;
		} catch (err) {
			// A viewer without scan.view gets a hidden section, not an
			// error toast on every poll.
			if (err instanceof ApiError && err.status === 403) {
				scanDenied = true;
			} else {
				toast('error', errMessage(err, 'scan data failed').slice(0, 400));
			}
		}
	}

	onMount(async () => {
		await load();
		const ag = await api<{ agents: { id: string; name: string }[] }>('/agents').catch(() => ({
			agents: [] as { id: string; name: string }[]
		}));
		agents = ag.agents;
		// Poll while a job for this app is in flight so status and the
		// release list stay live without websockets.
		poll = setInterval(() => {
			const busy = appJobs.some((j) => ['queued', 'claimed', 'running'].includes(j.status));
			if (busy || jobs.length === 0) void load();
		}, 3000);
	});
	onDestroy(() => {
		clearInterval(poll);
	});

	async function deploy(rollbackTo?: string): Promise<void> {
		deploying = true;
		try {
			await api(`/deploy/apps/${appId}/deploy`, {
				method: 'POST',
				body: rollbackTo ? { rollbackTo } : {}
			});
			toast('success', rollbackTo ? 'Rollback queued' : 'Deploy queued');
			await load();
		} catch (err) {
			toast('error', errMessage(err, 'deploy failed').slice(0, 400));
		} finally {
			deploying = false;
		}
	}

	async function runScan(): Promise<void> {
		scanning = true;
		try {
			const res = await api<{ deduped: boolean }>('/scan/run', {
				method: 'POST',
				body: { appId }
			});
			toast('success', res.deduped ? 'A scan is already in flight' : 'Scan queued');
			await load();
		} catch (err) {
			toast('error', errMessage(err, 'scan failed').slice(0, 400));
		} finally {
			scanning = false;
		}
	}

	async function recAction(rec: Recommendation, action: 'apply' | 'dismiss'): Promise<void> {
		recBusy = rec.id;
		try {
			await api(`/scan/recommendations/${rec.id}`, { method: 'POST', body: { action } });
			toast('success', action === 'apply' ? 'Fix applied' : 'Recommendation dismissed');
			await load();
		} catch (err) {
			toast('error', errMessage(err, 'action failed').slice(0, 400));
		} finally {
			recBusy = null;
		}
	}

	async function rotate(what: 'webhook' | 'key'): Promise<void> {
		try {
			const res = await api<{ webhook?: string; deployKeyPub?: string }>(
				`/deploy/apps/${appId}/rotate`,
				{ method: 'POST', body: { what } }
			);
			secretBox = { ...secretBox, ...res };
			toast('success', what === 'webhook' ? 'Webhook rotated' : 'Deploy key rotated');
		} catch (err) {
			toast('error', errMessage(err, 'rotate failed').slice(0, 400));
		}
	}

	async function saveEnv(): Promise<void> {
		envSaving = true;
		try {
			const env: Record<string, string> = {};
			for (const line of envText.split('\n')) {
				const t = line.trim();
				if (!t || t.startsWith('#')) continue;
				const eq = t.indexOf('=');
				if (eq === -1) throw new Error(`bad line: ${t.slice(0, 40)}`);
				env[t.slice(0, eq).trim()] = t.slice(eq + 1);
			}
			await api(`/deploy/apps/${appId}/env`, { method: 'PUT', body: { env } });
			envDirty = false;
			toast('success', 'Environment sealed and saved');
			await load();
		} catch (err) {
			toast('error', errMessage(err, 'env save failed').slice(0, 400));
		} finally {
			envSaving = false;
		}
	}

	async function saveEdit(body: Record<string, unknown>): Promise<void> {
		try {
			await api(`/deploy/apps/${appId}`, { method: 'PATCH', body });
			editOpen = false;
			toast('success', 'Application updated');
			await load();
		} catch (err) {
			toast('error', errMessage(err, 'update failed').slice(0, 400));
		}
	}

	async function remove(): Promise<void> {
		try {
			await api(`/deploy/apps/${appId}`, { method: 'DELETE' });
			toast('success', 'Application deleted');
			location.href = page.url.pathname.replace(/\/deploy\/[^/]+.*$/, '/deploy');
		} catch (err) {
			toast('error', errMessage(err, 'delete failed').slice(0, 400));
		}
	}

	async function copy(text: string, label: string): Promise<void> {
		await navigator.clipboard.writeText(text).catch(() => undefined);
		toast('info', `${label} copied`);
	}

	function releaseTone(status: string): string {
		if (status === 'live') return 'chip-on';
		if (status === 'failed' || status === 'rolled_back') return 'chip-down';
		if (status === 'pending') return 'chip-warn';
		return 'chip-muted';
	}
	function jobTone(status: string): string {
		if (status === 'succeeded') return 'chip-on';
		if (status === 'failed' || status === 'rolled_back') return 'chip-down';
		if (status === 'unknown') return 'chip-warn';
		return 'chip-muted';
	}
	function scanTone(status: string): string {
		if (status === 'done') return 'chip-on';
		if (status === 'failed') return 'chip-down';
		return 'chip-muted';
	}
	function sevTone(sev: string): string {
		if (sev === 'critical') return 'chip-down';
		if (sev === 'high' || sev === 'medium') return 'chip-warn';
		return 'chip-muted';
	}
</script>

{#if loading}
	<div class="card h-40 animate-pulse"></div>
{:else if !app}
	<div class="card p-10 text-center">
		<p class="text-muted">Application not found.</p>
	</div>
{:else}
	<PageHeader
		title={app.name}
		description="{app.source.kind} · {app.source.url ?? 'inline source'}"
	>
		<button class="btn btn-ghost" onclick={() => (editOpen = true)}
			><Pencil class="size-4" /> Edit</button
		>
		<button class="btn btn-ghost text-down-fg" onclick={() => (deleteOpen = true)}>
			<Trash class="size-4" />
		</button>
		<button class="btn btn-primary" onclick={() => deploy()} disabled={deploying}>
			{#if deploying}<RefreshCw class="size-4 animate-spin" />{:else}<Play class="size-4" />{/if}
			Deploy
		</button>
	</PageHeader>

	<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
		<StatTile
			label="Live release"
			value={live ? live.id.slice(0, 12) : 'none'}
			sub={live
				? fmtDateTime(new Date(live.liveAt ?? live.createdAt).toISOString())
				: 'never deployed'}
			tone={live ? 'ok' : 'default'}
		/>
		<StatTile label="System" value={agentName} sub={app.agentId} />
		<StatTile label="Runtime" value={app.runtime} sub={app.source.kind} />
		<StatTile
			label="Releases"
			value={String(releases.length)}
			sub="{releases.filter((r) => r.status === 'failed').length} failed"
		/>
	</div>

	{#if app.domains.length || app.ports.length}
		<div class="card mt-4 px-4 py-3">
			<span class="text-xs font-medium uppercase tracking-wide text-faint">Routing</span>
			<div class="mt-1.5 flex flex-wrap items-center gap-1.5">
				{#each app.domains as d (d)}
					<span class="chip">{d}</span>
				{/each}
				{#each app.ports as p (p.host)}
					<span class="chip font-mono text-faint"
						>{p.host}:{p.container}{p.local ? ' · local' : ''}</span
					>
				{/each}
			</div>
			{#if app.domains.length && !app.ports.length && !app.healthcheck.port}
				<p class="mt-1.5 text-xs text-degraded">
					No port mapping: the edge route needs a published port or a healthcheck port.
				</p>
			{/if}
		</div>
	{/if}

	<div class="mt-4 grid gap-4 lg:grid-cols-2">
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
					Webhook endpoint is configured{app.hasHookSecret ? ' with a signing secret' : ''}. The URL
					is only shown right after creation or rotation.
				</p>
			{/if}
			{#if secretBox.deployKeyPub}
				<div class="mb-3 rounded-lg border border-edge bg-raised p-3">
					<p class="mb-1 text-xs text-faint">
						Deploy key, add as a read-only deploy key on the repo
					</p>
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
		</div>

		<div class="card p-4">
			<h2 class="mb-3 text-sm font-semibold">Environment</h2>
			<Field
				label="Variables"
				hint={app.hasEnv
					? 'One KEY=VALUE per line. Sealed at rest; saved values are never shown again.'
					: 'One KEY=VALUE per line. Sealed at rest on save.'}
			>
				<textarea
					class="input min-h-32 font-mono text-xs"
					bind:value={envText}
					oninput={() => (envDirty = true)}
					placeholder="DATABASE_URL=postgres://..."
					spellcheck="false"></textarea>
			</Field>
			<div class="mt-3 flex justify-end">
				<button class="btn btn-primary btn-sm" onclick={saveEnv} disabled={!envDirty || envSaving}>
					{envSaving ? 'Saving…' : 'Seal and save'}
				</button>
			</div>
		</div>
	</div>

	<div class="mt-4 grid gap-4 lg:grid-cols-2">
		<div class="card">
			<h2 class="border-b border-edge px-4 py-3 text-sm font-semibold">Releases</h2>
			{#if releases.length === 0}
				<p class="px-4 py-6 text-center text-sm text-faint">No releases yet.</p>
			{:else}
				<div class="divide-y divide-edge">
					{#each releases as rel (rel.id)}
						<div class="flex items-center gap-3 px-4 py-2.5">
							<span class="chip {releaseTone(rel.status)}">{rel.status}</span>
							<div class="min-w-0 flex-1">
								<span class="block truncate font-mono text-xs">{rel.id}</span>
								<span class="text-xs text-faint">
									{rel.commit ? `${rel.commit.slice(0, 8)} · ` : ''}{fmtDateTime(
										new Date(rel.createdAt).toISOString()
									)}
								</span>
							</div>
							{#if rel.status !== 'live' && rel.status !== 'pending'}
								<button
									class="btn btn-ghost btn-sm"
									title="Roll back to this release"
									onclick={() => deploy(rel.id)}
									disabled={deploying}
								>
									<RotateCcw class="size-3.5" />
								</button>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<div class="card">
			<h2 class="border-b border-edge px-4 py-3 text-sm font-semibold">Jobs</h2>
			{#if appJobs.length === 0}
				<p class="px-4 py-6 text-center text-sm text-faint">No jobs yet.</p>
			{:else}
				<div class="divide-y divide-edge">
					{#each appJobs as job (job.id)}
						<div class="px-4 py-2.5">
							<div class="flex items-center gap-3">
								<span class="chip {jobTone(job.status)}">{job.status}</span>
								<span class="min-w-0 flex-1 truncate font-mono text-xs">#{job.id}</span>
								<span class="text-xs text-faint">
									{fmtDateTime(new Date(job.createdAt).toISOString())}
								</span>
							</div>
							{#if job.log}
								<pre
									class="thin-scroll mt-2 max-h-40 overflow-auto rounded-lg bg-raised p-2 font-mono text-[11px] leading-relaxed text-muted">{job.log.slice(
										-4000
									)}</pre>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	{#if !scanDenied}
		<div class="card mt-4">
			<div class="flex flex-wrap items-center justify-between gap-2 border-b border-edge px-4 py-3">
				<h2 class="flex items-center gap-2 text-sm font-semibold">
					<ShieldCheck class="size-4 text-faint" /> Security
				</h2>
				<div class="flex items-center gap-3">
					{#if scanLatest}
						<span class="text-xs text-faint">
							Last scan {fmtDateTime(new Date(scanLatest.startedAt).toISOString())}
						</span>
					{/if}
					{#if canScanManage}
						<button
							type="button"
							class="btn btn-sm"
							onclick={runScan}
							disabled={scanning ||
								scanLatest?.status === 'queued' ||
								scanLatest?.status === 'running'}
						>
							{#if scanning}<RefreshCw class="size-3.5 animate-spin" />{:else}<ScanSearch
									class="size-3.5"
								/>{/if}
							Run scan
						</button>
					{/if}
				</div>
			</div>

			<div class="px-4 py-3">
				{#if !scanLatest}
					<p class="text-sm text-faint">
						No scans yet. Run a trivy scan on the deployed image to check for vulnerabilities.
					</p>
				{:else}
					<div class="flex flex-wrap items-center gap-2">
						<span class="chip {scanTone(scanLatest.status)}">{scanLatest.status}</span>
						<span class="max-w-64 truncate font-mono text-xs text-muted" title={scanLatest.target}
							>{scanLatest.target}</span
						>
						{#if scanLatest.status === 'done'}
							{#if scanLatest.summary.critical > 0}
								<span class="chip chip-down">{scanLatest.summary.critical} critical</span>
							{/if}
							{#if scanLatest.summary.high > 0}
								<span class="chip chip-warn">{scanLatest.summary.high} high</span>
							{/if}
							{#if scanLatest.summary.medium > 0}
								<span class="chip chip-muted">{scanLatest.summary.medium} medium</span>
							{/if}
							{#if scanLatest.summary.low > 0}
								<span class="chip chip-muted">{scanLatest.summary.low} low</span>
							{/if}
							{#if scanLatest.summary.critical + scanLatest.summary.high + scanLatest.summary.medium + scanLatest.summary.low + scanLatest.summary.unknown === 0}
								<span class="chip chip-on">clean</span>
							{/if}
						{:else if scanLatest.status === 'failed'}
							<span class="text-xs text-down-fg">{scanLatest.error ?? 'scan failed'}</span>
						{/if}
					</div>

					{#if scanFindings.length > 0}
						<details class="mt-3" bind:open={findingsOpen}>
							<summary
								class="cursor-pointer text-xs font-medium text-muted"
								aria-expanded={findingsOpen}
							>
								{scanFindings.length} finding{scanFindings.length === 1 ? '' : 's'}
							</summary>
							<div class="thin-scroll mt-2 max-h-64 overflow-auto rounded-lg border border-edge">
								<table class="w-full text-xs">
									<thead>
										<tr class="border-b border-edge text-left text-faint">
											<th class="px-3 py-2 font-medium">Vulnerability</th>
											<th class="px-3 py-2 font-medium">Severity</th>
											<th class="px-3 py-2 font-medium">Package</th>
											<th class="px-3 py-2 font-medium">Fixed in</th>
										</tr>
									</thead>
									<tbody class="divide-y divide-edge">
										{#each scanFindings as f (`${f.vulnId}-${f.pkg}`)}
											<tr>
												<td class="px-3 py-1.5">
													<span class="font-mono">{f.vulnId}</span>
													{#if f.title}<span class="block text-faint">{f.title}</span>{/if}
												</td>
												<td class="px-3 py-1.5"
													><span class="chip {sevTone(f.severity)}">{f.severity}</span></td
												>
												<td class="px-3 py-1.5 font-mono"
													>{f.pkg}{f.installed ? ` ${f.installed}` : ''}</td
												>
												<td class="px-3 py-1.5 font-mono">{f.fixed ?? '-'}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						</details>
					{/if}
				{/if}
			</div>

			{#if recs.length > 0}
				<div class="border-t border-edge px-4 py-3">
					<h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-faint">
						Recommendations
					</h3>
					<ul class="space-y-2">
						{#each recs as rec (rec.id)}
							<li class="flex flex-wrap items-start gap-3 rounded-lg border border-edge p-3">
								<span class="chip {sevTone(rec.severity)} mt-0.5">{rec.severity}</span>
								<div class="min-w-0 flex-1">
									<p class="text-sm font-medium">{rec.title}</p>
									<p class="mt-0.5 text-xs text-muted">{rec.detail}</p>
								</div>
								{#if canScanManage}
									<div class="flex shrink-0 items-center gap-2">
										{#if rec.autoFixable}
											<button
												type="button"
												class="btn btn-primary btn-sm"
												disabled={recBusy === rec.id}
												onclick={() => recAction(rec, 'apply')}
											>
												Apply fix
											</button>
										{/if}
										<button
											type="button"
											class="btn btn-ghost btn-sm"
											disabled={recBusy === rec.id}
											onclick={() => recAction(rec, 'dismiss')}
										>
											Dismiss
										</button>
									</div>
								{/if}
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>
	{/if}

	{#if releases.length === 0 && jobs.length === 0}
		<div class="card mt-4 p-8 text-center">
			<Rocket class="mx-auto mb-2 size-7 text-faint" />
			<p class="text-sm text-muted">Queue the first deploy to build on {agentName}.</p>
		</div>
	{/if}
{/if}

<DeployAppForm bind:open={editOpen} {app} {agents} onsave={saveEdit} />
<ConfirmDialog
	bind:open={deleteOpen}
	title="Delete application"
	description="Deletes the app record, sealed env, and deploy key. Running containers on the agent are not removed."
	confirmLabel="Delete"
	danger
	onconfirm={remove}
/>
