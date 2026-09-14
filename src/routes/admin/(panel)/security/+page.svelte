<script lang="ts">
	import { onMount } from 'svelte';
	import { ShieldCheck, ScanSearch, FileExclamationPoint } from '@lucide/svelte';
	import { page } from '$app/state';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import StatTile from '$lib/components/admin/StatTile.svelte';
	import type { DeployApp } from '$lib/shared/deploy';
	import type { Recommendation, ScanReport } from '$lib/shared/scan';
	import { adminHref, api, ApiError, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import { fmtDateTime } from '$lib/utils/format';

	let apps = $state<DeployApp[]>([]);
	let latest = $state<ScanReport[]>([]);
	let openRecs = $state<Recommendation[]>([]);
	let loading = $state(true);
	let denied = $state(false);
	let scanning = $state<string | null>(null);

	const canManage = $derived(
		((page.data.perms as string[] | undefined) ?? []).includes('scan.manage')
	);
	const latestByApp = $derived(
		Object.fromEntries(latest.map((r) => [r.appId, r])) as Partial<Record<string, ScanReport>>
	);
	const recsByApp = $derived.by(() => {
		const m: Partial<Record<string, Recommendation[]>> = {};
		for (const r of openRecs) {
			(m[r.appId] ??= []).push(r);
		}
		return m;
	});
	const seriousTotal = $derived(
		latest
			.filter((r) => r.status === 'done')
			.reduce((n, r) => n + r.summary.critical + r.summary.high, 0)
	);
	const scannedApps = $derived(apps.filter((a) => a.id in latestByApp).length);

	async function load(): Promise<void> {
		try {
			const [a, r, rec] = await Promise.all([
				api<{ apps: DeployApp[] }>('/deploy/apps'),
				api<{ reports: ScanReport[] }>('/scan/reports'),
				api<{ recommendations: Recommendation[] }>('/scan/recommendations')
			]);
			apps = a.apps;
			latest = r.reports;
			openRecs = rec.recommendations;
		} catch (err) {
			if (err instanceof ApiError && err.status === 403) denied = true;
			else toast('error', errMessage(err, 'load failed').slice(0, 400));
		} finally {
			loading = false;
		}
	}

	onMount(load);

	async function runScan(appId: string): Promise<void> {
		scanning = appId;
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
			scanning = null;
		}
	}

	function scanTone(status: string): string {
		if (status === 'done') return 'chip-on';
		if (status === 'failed') return 'chip-down';
		return 'chip-muted';
	}
</script>

<PageHeader
	title="Security"
	description="Image scans and hardening recommendations across deployed apps"
/>

{#if loading}
	<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
		{#each [0, 1, 2, 3] as i (i)}
			<div class="card h-24 animate-pulse"></div>
		{/each}
	</div>
{:else if denied}
	<div class="card p-10 text-center">
		<ShieldCheck class="mx-auto mb-3 size-8 text-faint" />
		<p class="text-muted">Your role does not include the scan.view permission.</p>
	</div>
{:else}
	<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
		<StatTile label="Apps" value={String(apps.length)} sub="{scannedApps} scanned" />
		<StatTile
			label="Open recommendations"
			value={String(openRecs.length)}
			sub="across all apps"
			tone={openRecs.length ? 'warn' : 'ok'}
		/>
		<StatTile
			label="Critical + high"
			value={String(seriousTotal)}
			sub="latest scan per app"
			tone={seriousTotal ? 'bad' : 'ok'}
		/>
		<StatTile
			label="Never scanned"
			value={String(apps.length - scannedApps)}
			sub="no scan report"
			tone={apps.length - scannedApps ? 'warn' : 'ok'}
		/>
	</div>

	{#if apps.length === 0}
		<div class="card mt-4 p-10 text-center">
			<ScanSearch class="mx-auto mb-3 size-8 text-faint" />
			<p class="text-muted">No applications yet.</p>
			<p class="mt-1 text-xs text-faint">Deploy an app, then scan its image from here.</p>
			<a href={adminHref('/deploy')} class="btn btn-primary mt-4 inline-flex">Go to deployments</a>
		</div>
	{:else}
		<div class="card mt-4">
			<h2 class="border-b border-edge px-4 py-3 text-sm font-semibold">Apps</h2>
			<div class="divide-y divide-edge">
				{#each apps as app (app.id)}
					{@const scan = latestByApp[app.id]}
					{@const appRecs = recsByApp[app.id] ?? []}
					<div class="flex flex-wrap items-center gap-3 px-4 py-3">
						<div class="min-w-0 flex-1">
							<a
								href={adminHref(`/deploy/${app.id}`)}
								class="block truncate text-sm font-semibold hover:underline"
							>
								{app.name}
							</a>
							<span class="text-xs text-faint">
								{scan
									? `${scan.target} · ${fmtDateTime(new Date(scan.startedAt).toISOString())}`
									: 'never scanned'}
							</span>
						</div>
						{#if scan}
							<span class="chip {scanTone(scan.status)}">{scan.status}</span>
							{#if scan.status === 'done'}
								{#if scan.summary.critical > 0}
									<span class="chip chip-down">{scan.summary.critical} crit</span>
								{/if}
								{#if scan.summary.high > 0}
									<span class="chip chip-warn">{scan.summary.high} high</span>
								{/if}
								{#if scan.summary.critical + scan.summary.high === 0}
									<span class="chip chip-on">no crit/high</span>
								{/if}
							{/if}
						{:else}
							<span class="chip chip-muted">no scan</span>
						{/if}
						{#if appRecs.length > 0}
							<span class="chip chip-warn">
								<FileExclamationPoint class="size-3" />
								{appRecs.length} open
							</span>
						{/if}
						{#if canManage}
							<button
								type="button"
								class="btn btn-ghost btn-sm"
								disabled={scanning === app.id ||
									scan?.status === 'queued' ||
									scan?.status === 'running'}
								onclick={() => runScan(app.id)}
								aria-label="Run scan on {app.name}"
							>
								<ScanSearch class="size-3.5" />
							</button>
						{/if}
					</div>
				{/each}
			</div>
		</div>

		{#if openRecs.length > 0}
			<div class="card mt-4">
				<h2 class="border-b border-edge px-4 py-3 text-sm font-semibold">Open recommendations</h2>
				<div class="divide-y divide-edge">
					{#each openRecs as rec (rec.id)}
						{@const app = apps.find((a) => a.id === rec.appId)}
						<a
							href={adminHref(`/deploy/${rec.appId}`)}
							class="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-raised"
						>
							<span
								class="chip {rec.severity === 'critical' || rec.severity === 'high'
									? 'chip-warn'
									: 'chip-muted'}"
								class:chip-down={rec.severity === 'critical'}
							>
								{rec.severity}
							</span>
							<span class="min-w-0 flex-1 truncate text-sm">{rec.title}</span>
							<span class="text-xs text-faint">{app?.name ?? rec.appId}</span>
						</a>
					{/each}
				</div>
			</div>
		{/if}
	{/if}
{/if}
