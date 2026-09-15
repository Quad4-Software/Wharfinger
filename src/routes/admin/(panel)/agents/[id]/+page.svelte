<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { useInterval } from 'runed';
	import {
		ArrowLeft,
		Container,
		Copy,
		KeyRound,
		LoaderCircle,
		LogIn,
		Network,
		Pencil,
		Play,
		RefreshCw,
		RotateCw,
		Square,
		ShieldCheck,
		Trash,
		Waypoints
	} from '@lucide/svelte';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import AgentOps from '$lib/components/admin/AgentOps.svelte';
	import Modal from '$lib/components/admin/Modal.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import ConfirmDialog from '$lib/components/admin/ConfirmDialog.svelte';
	import MetricChart from '$lib/components/admin/MetricChart.svelte';
	import DataTable from '$lib/components/admin/DataTable.svelte';
	import StatTile from '$lib/components/admin/StatTile.svelte';
	import GaugeBar from '$lib/components/admin/GaugeBar.svelte';
	import { adminHref, api, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import { fmtBytes, fmtPct, fmtRate, fmtUptime, relativeTime } from '$lib/utils/format';
	import type {
		AgentContainer,
		AgentPayloadView,
		AgentProcess,
		AgentSample,
		AgentService,
		AgentView,
		EdgeReportView,
		EdgeSampleView,
		K8sPodView
	} from '$lib/shared/agents';
	import type { PublicUser as User } from '$lib/shared/auth';

	const { data }: { data: { user: User } } = $props();
	const id = $derived(page.params.id ?? '');
	const isAdmin = $derived(data.user.role === 'admin');
	const RANGES = ['15m', '1h', '6h', '24h', '7d', '30d'] as const;

	let agent = $state<AgentView | null>(null);
	let payload = $state<AgentPayloadView | null>(null);
	let samples = $state<AgentSample[]>([]);
	let range = $state<(typeof RANGES)[number]>('1h');
	let loading = $state(true);
	let historyLoading = $state(false);
	let notFound = $state(false);

	let renameOpen = $state(false);
	let renameVal = $state('');
	let revokeOpen = $state(false);
	let rotateOpen = $state(false);
	let rotatedOpen = $state(false);
	let rotated = $state<{ token: string; pubkey: string } | null>(null);
	let busy = $state(false);
	let svcFilter = $state<'all' | 'failed' | 'inactive'>('all');
	let svcBusy = $state<string | null>(null);
	let edge = $state<EdgeReportView | null>(null);
	let edgeSamples = $state<EdgeSampleView[]>([]);
	let portFilter = $state('');

	const filteredPorts = $derived.by(() => {
		const ports = payload?.ports ?? [];
		const needle = portFilter.trim().toLowerCase();
		const out = needle
			? ports.filter(
					(p) =>
						String(p.port).includes(needle) ||
						p.address.toLowerCase().includes(needle) ||
						(p.process ?? '').toLowerCase().includes(needle)
				)
			: ports;
		return out.slice(0, 400);
	});

	async function load(): Promise<void> {
		try {
			const r = await api<{ agent: AgentView; payload: AgentPayloadView | null }>(`/agents/${id}`);
			agent = r.agent;
			payload = r.payload;
		} catch (err) {
			if ((err as { status?: number }).status === 404) notFound = true;
			else toast('error', errMessage(err));
		} finally {
			loading = false;
		}
	}

	async function loadHistory(r: typeof range): Promise<void> {
		historyLoading = true;
		try {
			const res = await api<{ samples: AgentSample[] }>(`/agents/${id}/history?range=${r}`);
			samples = res.samples;
		} catch (err) {
			toast('error', errMessage(err));
		} finally {
			historyLoading = false;
		}
	}

	async function loadEdge(): Promise<void> {
		try {
			const res = await api<{ samples: EdgeSampleView[]; latest: EdgeReportView | null }>(
				`/agents/${id}/edge?range=24h`
			);
			edge = res.latest;
			edgeSamples = res.samples;
		} catch {
			// Edge feed is optional; a 404/403 simply means none is wired.
		}
	}

	function setRange(r: (typeof RANGES)[number]): void {
		if (r === range) return;
		range = r;
		void loadHistory(r);
	}

	onMount(() => {
		void load();
		void loadHistory(range);
		void loadEdge();
	});
	useInterval(() => 30_000, {
		callback: () => {
			if (document.visibilityState !== 'visible') return;
			void load();
			void loadHistory(range);
			void loadEdge();
		}
	});

	async function rename(): Promise<void> {
		busy = true;
		try {
			await api(`/agents/${id}`, { method: 'PATCH', body: { name: renameVal.trim() } });
			toast('success', 'Renamed');
			renameOpen = false;
			await load();
		} catch (err) {
			toast('error', errMessage(err));
		} finally {
			busy = false;
		}
	}

	async function rotate(): Promise<void> {
		busy = true;
		try {
			rotated = await api(`/agents/${id}/token`, { method: 'POST' });
			rotateOpen = false;
			rotatedOpen = true;
			toast('success', 'Token rotated; update the agent config');
		} catch (err) {
			toast('error', errMessage(err));
		} finally {
			busy = false;
		}
	}

	async function revoke(): Promise<void> {
		busy = true;
		try {
			await api(`/agents/${id}`, { method: 'DELETE' });
			toast('success', 'System revoked');
			revokeOpen = false;
			await load();
		} catch (err) {
			toast('error', errMessage(err));
		} finally {
			busy = false;
		}
	}

	async function queueSvc(verb: string, unit: string): Promise<void> {
		svcBusy = `${verb}:${unit}`;
		try {
			await api(`/agents/${id}/task`, {
				method: 'POST',
				body: { action: `service.${verb}`, unit }
			});
			toast('success', `${verb} queued for ${unit}`);
		} catch (err) {
			toast('error', errMessage(err));
		} finally {
			svcBusy = null;
		}
	}

	function copy(text: string): void {
		navigator.clipboard
			.writeText(text)
			.then(() => {
				toast('success', 'Copied');
			})
			.catch(() => {
				toast('error', 'copy failed');
			});
	}

	const series = $derived({
		cpu: [{ label: 'CPU', color: '#10b981', points: samples.map((s) => ({ ts: s.ts, v: s.cpu })) }],
		mem: [
			{
				label: 'Memory',
				color: '#60a5fa',
				points: samples.map((s) => ({ ts: s.ts, v: s.mem_pct }))
			}
		],
		disk: [
			{ label: 'Disk', color: '#f59e0b', points: samples.map((s) => ({ ts: s.ts, v: s.disk_pct })) }
		],
		load: [
			{ label: 'Load 1m', color: '#a78bfa', points: samples.map((s) => ({ ts: s.ts, v: s.load1 })) }
		],
		temp: [
			{
				label: 'Temp max',
				color: '#ef4444',
				points: samples.map((s) => ({ ts: s.ts, v: s.temp_max }))
			}
		],
		net: [
			{ label: 'rx', color: '#60a5fa', points: samples.map((s) => ({ ts: s.ts, v: s.rx_bps })) },
			{ label: 'tx', color: '#f59e0b', points: samples.map((s) => ({ ts: s.ts, v: s.tx_bps })) }
		]
	});

	$effect(() => {
		if (!rotatedOpen) rotated = null;
	});

	const filteredServices = $derived.by(() => {
		const svcs = payload?.services ?? [];
		if (svcFilter === 'failed') return svcs.filter((s) => s.state === 'failed');
		if (svcFilter === 'inactive') return svcs.filter((s) => s.state !== 'active');
		return svcs;
	});

	const failedCount = $derived(
		(payload?.services ?? []).filter((s) => s.state === 'failed').length
	);
</script>

{#if notFound}
	<div class="card px-6 py-10 text-center">
		<p class="text-sm text-muted">System not found.</p>
		<a class="btn btn-ghost mt-3" href={adminHref('/agents')}><ArrowLeft class="size-4" /> Back</a>
	</div>
{:else if loading && !agent}
	<div class="flex items-center justify-center py-16 text-faint">
		<LoaderCircle class="size-6 animate-spin" />
	</div>
{:else if agent}
	<div class="mb-4">
		<a
			class="inline-flex items-center gap-1 text-xs text-faint hover:text-fg"
			href={adminHref('/agents')}
		>
			<ArrowLeft class="size-3.5" /> All systems
		</a>
	</div>
	<PageHeader
		title={agent.name}
		description={[
			agent.meta?.hostname,
			[agent.meta?.os, agent.meta?.arch].filter(Boolean).join('/'),
			agent.meta?.kernel,
			agent.meta?.version ? `agent ${agent.meta.version}` : null
		]
			.filter(Boolean)
			.join(' · ')}
	>
		{#if isAdmin}
			<button
				class="btn btn-ghost"
				onclick={() => {
					renameVal = agent?.name ?? '';
					renameOpen = true;
				}}
				title="Rename"
			>
				<Pencil class="size-4" />
			</button>
			<button class="btn btn-ghost" onclick={() => (rotateOpen = true)} title="Rotate token">
				<KeyRound class="size-4" />
			</button>
			<button class="btn btn-ghost text-down" onclick={() => (revokeOpen = true)} title="Revoke">
				<Trash class="size-4" />
			</button>
		{/if}
		<button class="btn btn-ghost" onclick={load} aria-label="Refresh">
			<RefreshCw class="size-4 {historyLoading ? 'animate-spin' : ''}" />
		</button>
	</PageHeader>

	<div class="mb-4 flex flex-wrap items-center gap-3 text-xs text-muted">
		<span class="inline-flex items-center gap-1.5">
			<span
				class="size-2 rounded-full {agent.revoked
					? 'bg-faint'
					: agent.online
						? 'bg-up'
						: 'bg-down'}"
			></span>
			{agent.revoked ? 'revoked' : agent.online ? 'online' : 'offline'}
		</span>
		<span>last seen {agent.lastSeenAt ? relativeTime(agent.lastSeenAt) : 'never'}</span>
		<span>fingerprint {agent.fingerprintBound ? 'bound' : 'unbound'}</span>
		<span class={agent.keyBound ? '' : 'text-degraded'}>
			key {agent.keyBound ? 'bound' : 'legacy'}
		</span>
		{#if payload}<span>uptime {fmtUptime(payload.agent.uptimeSec)}</span>{/if}
		{#if agent.mutedUntil && agent.mutedUntil > Date.now()}
			<span class="text-degraded"
				>alerts muted until {new Date(agent.mutedUntil).toLocaleTimeString()}</span
			>
		{/if}
	</div>

	<AgentOps {agent} canManage={isAdmin && !agent.revoked} onqueued={() => void load()} />

	{#if payload}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
			<StatTile
				label="CPU"
				value={fmtPct(payload.cpu.pct)}
				sub="{payload.cpu.cores} cores{payload.cpu.freqMhz
					? ` @ ${(payload.cpu.freqMhz / 1000).toFixed(1)} GHz`
					: ''}"
			/>
			<StatTile
				label="Memory"
				value={fmtPct(payload.mem.pct)}
				sub="{fmtBytes(payload.mem.used)} of {fmtBytes(payload.mem.total)}"
			/>
			<StatTile
				label="Load 1m"
				value={payload.cpu.load1.toFixed(2)}
				sub="5m {payload.cpu.load5.toFixed(2)} · 15m {payload.cpu.load15.toFixed(2)}"
			/>
			<StatTile
				label="Network"
				value={fmtRate(payload.net.rxBps + payload.net.txBps)}
				sub="rx {fmtRate(payload.net.rxBps)} · tx {fmtRate(payload.net.txBps)}"
			/>
			<StatTile
				label="Connections"
				value={String(payload.connections.total)}
				sub="{payload.connections.established} established · {payload.connections.listen} listening"
			/>
			<StatTile
				label="Containers"
				value={payload.docker ? `${payload.docker.running}/${payload.docker.total}` : 'N/A'}
				sub={failedCount > 0
					? `${failedCount} failed service${failedCount === 1 ? '' : 's'}`
					: 'docker'}
			/>
		</div>

		<div class="mt-4 flex flex-wrap items-center gap-2">
			<span class="text-xs font-medium text-faint">Range</span>
			{#each RANGES as r (r)}
				<button
					class="btn {r === range ? 'btn-primary' : 'btn-ghost'} !px-2.5 !py-1 text-xs"
					onclick={() => {
						setRange(r);
					}}
					disabled={historyLoading}
				>
					{r}
				</button>
			{/each}
		</div>

		<div class="mt-3 grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
			<div class="card p-4">
				<h2 class="mb-2 text-sm font-medium text-muted">CPU %</h2>
				<MetricChart series={series.cpu} unit="%" max={100} />
			</div>
			<div class="card p-4">
				<h2 class="mb-2 text-sm font-medium text-muted">Memory %</h2>
				<MetricChart series={series.mem} unit="%" max={100} />
			</div>
			<div class="card p-4">
				<h2 class="mb-2 text-sm font-medium text-muted">Disk % (fullest mount)</h2>
				<MetricChart series={series.disk} unit="%" max={100} />
			</div>
			<div class="card p-4">
				<h2 class="mb-2 text-sm font-medium text-muted">Load average (1m)</h2>
				<MetricChart series={series.load} />
			</div>
			<div class="card p-4">
				<h2 class="mb-2 text-sm font-medium text-muted">Network throughput</h2>
				<MetricChart series={series.net} format={(v: number) => fmtRate(v)} />
			</div>
			<div class="card p-4">
				<h2 class="mb-2 text-sm font-medium text-muted">Temperature max</h2>
				<MetricChart series={series.temp} unit="°C" />
			</div>
		</div>

		<div class="mt-4 grid gap-4 xl:grid-cols-2">
			{#if payload.disks?.length}
				<div class="card p-4">
					<h2 class="mb-3 text-sm font-medium text-muted">Filesystems</h2>
					<div class="space-y-2.5">
						{#each payload.disks as d (d.mount)}
							<GaugeBar
								pct={d.pct}
								label="{d.mount} · {d.fstype}"
								detail="{fmtBytes(d.used)} / {fmtBytes(d.total)}{d.inodesPct !== undefined
									? ` · inodes ${d.inodesPct.toFixed(0)}%`
									: ''}"
							/>
						{/each}
					</div>
				</div>
			{/if}

			<div class="space-y-4">
				{#if (payload.temps?.length ?? 0) + (payload.gpus?.length ?? 0) > 0}
					<div class="card p-4">
						<h2 class="mb-3 text-sm font-medium text-muted">Thermals & GPUs</h2>
						<div class="space-y-1.5 text-xs">
							{#each payload.temps ?? [] as t (t.label)}
								<div class="flex justify-between gap-2">
									<span class="truncate text-muted">{t.label}</span>
									<span
										class="font-mono {t.celsius >= 85
											? 'text-down'
											: t.celsius >= 70
												? 'text-degraded'
												: 'text-fg'}">{t.celsius.toFixed(1)}°C</span
									>
								</div>
							{/each}
							{#each payload.gpus ?? [] as g (g.name)}
								<div class="flex justify-between gap-2 border-t border-edge/50 pt-1.5">
									<span class="truncate text-muted">{g.vendor} {g.name}</span>
									<span class="font-mono text-fg">
										{[
											g.utilPct !== undefined ? `${g.utilPct.toFixed(0)}%` : null,
											g.tempC !== undefined ? `${g.tempC.toFixed(0)}°C` : null,
											g.memUsed !== undefined && g.memTotal !== undefined
												? `${fmtBytes(g.memUsed)}/${fmtBytes(g.memTotal)}`
												: null,
											g.powerW !== undefined ? `${g.powerW.toFixed(0)}W` : null
										]
											.filter(Boolean)
											.join(' · ')}
									</span>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<div class="card p-4">
					<h2 class="mb-3 flex items-center gap-1.5 text-sm font-medium text-muted">
						<ShieldCheck class="size-4" /> Security
					</h2>
					<div class="space-y-1.5 text-xs">
						<div class="flex justify-between">
							<span class="text-muted">UFW</span>
							<span class="text-fg">
								{payload.security.ufw
									? payload.security.ufw.enabled
										? `active · ${payload.security.ufw.rules} rules`
										: 'inactive'
									: 'not installed'}
							</span>
						</div>
						{#if payload.security.ufw?.bypassed?.length}
							{@const ufw = payload.security.ufw}
							<div class="flex justify-between pl-3">
								<span class="text-degraded">container bypass</span>
								<span
									class="max-w-56 truncate font-mono text-degraded"
									title={ufw.bypassed?.join(', ')}>{ufw.bypassed?.length} ports</span
								>
							</div>
						{/if}
						{#if payload.security.firewalld}
							{@const fwd = payload.security.firewalld}
							<div class="flex justify-between">
								<span class="text-muted">firewalld</span>
								<span class="text-fg">
									{fwd.enabled ? `active · ${fwd.zones?.length ?? 0} zones` : 'inactive'}
								</span>
							</div>
							{#if fwd.bypassed?.length}
								<div class="flex justify-between pl-3">
									<span class="text-degraded">container bypass</span>
									<span
										class="max-w-56 truncate font-mono text-degraded"
										title={fwd.bypassed.join(', ')}>{fwd.bypassed.length} ports</span
									>
								</div>
							{/if}
						{/if}
						<div class="flex justify-between">
							<span class="text-muted">Fail2ban</span>
							<span class="text-fg">
								{payload.security.fail2ban
									? `${payload.security.fail2ban.jails?.length ?? 0} jails`
									: 'not installed'}
							</span>
						</div>
						{#each payload.security.fail2ban?.jails ?? [] as j (j.name)}
							<div class="flex justify-between pl-3">
								<span class="truncate text-faint">{j.name}</span>
								<span class="font-mono {j.banned > 0 ? 'text-degraded' : 'text-fg'}"
									>{j.banned} banned</span
								>
							</div>
						{/each}
						<div class="flex justify-between">
							<span class="text-muted">CrowdSec</span>
							<span class="text-fg">
								{payload.security.crowdsec
									? `${payload.security.crowdsec.decisions} decisions · ${payload.security.crowdsec.alerts} alerts`
									: 'not installed'}
							</span>
						</div>
						{#each payload.security.crowdsec?.bans?.slice(0, 8) ?? [] as b (b.value)}
							<div class="flex justify-between pl-3">
								<span class="max-w-56 truncate font-mono text-faint" title={b.scenario}
									>{b.value}</span
								>
								<span class="truncate pl-2 text-degraded">{b.scenario}</span>
							</div>
						{/each}
						<div class="flex justify-between border-t border-edge/50 pt-1.5">
							<span class="text-muted">Listening ports</span>
							<span class="font-mono text-fg">{payload.ports?.length ?? 0}</span>
						</div>
					</div>
				</div>

				{#if payload.logins}
					{@const lg = payload.logins}
					<div class="card p-4">
						<h2 class="mb-3 flex items-center gap-1.5 text-sm font-medium text-muted">
							<LogIn class="size-4" /> Logins
							{#if lg.failed24h > 0}
								<span class="chip ml-1 text-down">{lg.failed24h} failed / 24h</span>
							{/if}
						</h2>
						<div class="space-y-1.5 text-xs">
							{#if lg.note}
								<p class="text-degraded">{lg.note}</p>
							{/if}
							<div class="flex justify-between">
								<span class="text-muted">Remote sessions</span>
								<span class="font-mono text-fg">{lg.remote}</span>
							</div>
							{#if lg.sessions?.length}
								<div class="flex flex-wrap gap-1.5">
									{#each lg.sessions as s (`${s.user}-${s.tty}`)}
										<span
											class="rounded-md border border-edge bg-bg px-1.5 py-0.5 font-mono text-muted"
											title="{s.tty}{s.since ? ` · since ${s.since}` : ''}"
										>
											{s.user}{s.from ? `@${s.from}` : ` · ${s.tty}`}
										</span>
									{/each}
								</div>
							{/if}
							{#if lg.topFailed?.length}
								<div class="flex justify-between border-t border-edge/50 pt-1.5">
									<span class="text-muted">Top failed sources (24h)</span>
								</div>
								{#each lg.topFailed as o (o.src)}
									<div class="flex justify-between pl-3">
										<span class="max-w-56 truncate font-mono text-faint">{o.src}</span>
										<span class="font-mono text-degraded">{o.count} failed</span>
									</div>
								{/each}
							{/if}
							{#if lg.events?.length}
								<div class="space-y-1 border-t border-edge/50 pt-1.5">
									{#each lg.events as e (`${e.ts}-${e.user}-${e.src}-${e.kind}`)}
										<div class="flex items-center justify-between gap-2">
											<span class="chip shrink-0 {e.kind === 'accepted' ? 'text-up' : 'text-down'}"
												>{e.kind}</span
											>
											<span class="min-w-0 truncate font-mono text-fg" title="{e.user}@{e.src}"
												>{e.user}<span class="text-faint">@{e.src}</span></span
											>
											<span class="shrink-0 text-faint">{e.method ?? ''} · {e.ts}</span>
										</div>
									{/each}
								</div>
							{:else if !lg.note}
								<p class="text-faint">No recent ssh events.</p>
							{/if}
						</div>
					</div>
				{/if}

				{#if payload.traefik}
					<div class="card p-4">
						<h2 class="mb-3 flex items-center gap-1.5 text-sm font-medium text-muted">
							<Waypoints class="size-4" /> Traefik
						</h2>
						<div class="space-y-1.5 text-xs">
							<div class="flex justify-between">
								<span class="text-muted">HTTP routers / services</span>
								<span class="font-mono text-fg"
									>{payload.traefik.httpRouters} / {payload.traefik.httpServices}</span
								>
							</div>
							<div class="flex justify-between">
								<span class="text-muted">TCP routers / services</span>
								<span class="font-mono text-fg"
									>{payload.traefik.tcpRouters} / {payload.traefik.tcpServices}</span
								>
							</div>
							<div class="flex justify-between">
								<span class="text-muted">UDP routers</span>
								<span class="font-mono text-fg">{payload.traefik.udpRouters}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-muted">Middlewares</span>
								<span class="font-mono text-fg">{payload.traefik.middlewares}</span>
							</div>
							<div class="flex justify-between border-t border-edge/50 pt-1.5">
								<span class="text-muted">Router errors / warnings</span>
								<span
									class="font-mono {payload.traefik.routerErrors > 0
										? 'text-down'
										: payload.traefik.routerWarnings > 0
											? 'text-degraded'
											: 'text-fg'}"
									>{payload.traefik.routerErrors} / {payload.traefik.routerWarnings}</span
								>
							</div>
						</div>
					</div>
				{/if}

				{#if payload.edgeCerts?.length}
					<div class="card p-4">
						<h2 class="mb-3 flex items-center gap-1.5 text-sm font-medium text-muted">
							<ShieldCheck class="size-4" /> Edge certificates
						</h2>
						<div class="space-y-1.5 text-xs">
							{#each payload.edgeCerts as c (c.host)}
								<div class="flex items-center justify-between gap-2">
									<span class="max-w-52 truncate font-mono text-fg" title={c.host}>{c.host}</span>
									<span class="flex items-center gap-2">
										<span class="text-faint" title={c.issuer}
											>{new Date(c.expiresAt).toLocaleDateString()}</span
										>
										<span
											class="chip {c.status === 'valid'
												? 'text-up'
												: c.status === 'expired'
													? 'text-down'
													: 'text-degraded'}">{c.status}</span
										>
									</span>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				{#if payload.reticulum}
					{@const rns = payload.reticulum}
					<div class="card p-4">
						<h2 class="mb-3 flex items-center gap-1.5 text-sm font-medium text-muted">
							<Waypoints class="size-4" /> Reticulum
							<span class="chip ml-1 {rns.running ? 'text-up' : 'text-down'}"
								>{rns.running ? 'running' : 'stopped'}</span
							>
						</h2>
						<div class="space-y-1.5 text-xs">
							<div class="flex justify-between">
								<span class="text-muted">Daemon</span>
								<span class="font-mono text-fg"
									>{rns.flavor ?? 'reticulum'}{rns.version ? ` · ${rns.version}` : ''}</span
								>
							</div>
							{#if rns.identity}
								<div class="flex justify-between">
									<span class="text-muted">Transport</span>
									<span class="max-w-44 truncate font-mono text-fg" title={rns.identity}
										>&lt;{rns.identity}&gt;</span
									>
								</div>
							{/if}
							{#if rns.paths}
								<div class="flex justify-between">
									<span class="text-muted">Known paths</span>
									<span class="font-mono text-fg">{rns.paths}</span>
								</div>
							{/if}
							{#if rns.uptimeSec}
								<div class="flex justify-between">
									<span class="text-muted">Uptime</span>
									<span class="font-mono text-fg">{fmtUptime(rns.uptimeSec)}</span>
								</div>
							{/if}
							{#each rns.interfaces ?? [] as i (i.name)}
								<div class="flex justify-between pl-3">
									<span class="max-w-40 truncate text-faint" title={i.type ?? ''}>{i.name}</span>
									<span class="{i.status === 'up' ? 'text-up' : 'text-down'} font-mono"
										>{i.status}{i.clients ? ` · ${i.clients} peers` : ''}</span
									>
								</div>
							{/each}
							{#if rns.findings?.length}
								<div class="border-t border-edge/50 pt-1.5">
									<span class="text-muted">Findings</span>
									{#each rns.findings as f (f)}
										<div class="mt-0.5 truncate pl-3 text-degraded" title={f}>{f}</div>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				{/if}
			</div>
		</div>

		{#if payload.docker?.containers?.length}
			<div class="card mt-4 p-4">
				<h2 class="mb-3 flex items-center gap-1.5 text-sm font-medium text-muted">
					<Container class="size-4" /> Containers ({payload.docker.running}/{payload.docker.total})
				</h2>
				<DataTable
					columns={[
						{ label: 'Name', sort: (c: AgentContainer) => c.name },
						{ label: 'Image', sort: (c: AgentContainer) => c.image },
						{ label: 'Runtime', sort: (c: AgentContainer) => c.runtime ?? 'docker' },
						{ label: 'State', sort: (c: AgentContainer) => c.state },
						{ label: 'CPU', sort: (c: AgentContainer) => c.cpuPct ?? -1 },
						{ label: 'Memory', sort: (c: AgentContainer) => c.memUsed ?? -1 },
						{ label: 'Restarts', sort: (c: AgentContainer) => c.restarts ?? 0 }
					]}
					rows={payload.docker.containers}
					rowKey={(c: AgentContainer) => c.id}
					searchable
					searchPlaceholder="Filter containers..."
				>
					{#snippet row(c: AgentContainer)}
						<td class="py-1.5 pr-3 font-medium text-fg">{c.name}</td>
						<td class="max-w-48 truncate py-1.5 pr-3 text-muted">{c.image}</td>
						<td class="py-1.5 pr-3 text-faint">{c.runtime ?? 'docker'}</td>
						<td class="py-1.5 pr-3">
							<span class={c.state === 'running' ? 'text-up' : 'text-down'}>{c.state}</span>
						</td>
						<td class="py-1.5 pr-3 font-mono text-fg"
							>{c.cpuPct !== undefined ? fmtPct(c.cpuPct) : '–'}</td
						>
						<td class="py-1.5 pr-3 font-mono text-fg">
							{c.memUsed !== undefined ? fmtBytes(c.memUsed) : '–'}{c.memLimit !== undefined
								? ` / ${fmtBytes(c.memLimit)}`
								: ''}
						</td>
						<td class="py-1.5 font-mono {c.restarts ? 'text-degraded' : 'text-fg'}"
							>{c.restarts ?? 0}</td
						>
					{/snippet}
				</DataTable>
			</div>
		{/if}

		{#if payload.k8s}
			<div class="card mt-4 p-4">
				<h2 class="mb-3 flex items-center gap-1.5 text-sm font-medium text-muted">
					<Network class="size-4" /> Kubernetes pods ({payload.k8s.running} running /
					{payload.k8s.pods} total · {payload.k8s.restarts} restarts)
				</h2>
				<div class="mb-3 flex flex-wrap gap-2 text-xs">
					{#each [['running', payload.k8s.running, 'text-up'], ['pending', payload.k8s.pending, 'text-degraded'], ['failed', payload.k8s.failed, 'text-down'], ['succeeded', payload.k8s.succeeded, 'text-faint']] as const as [label, n, cls] (label)}
						{#if n > 0}<span class="chip {cls}">{label}: {n}</span>{/if}
					{/each}
				</div>
				{#if payload.k8s.podList?.length}
					<DataTable
						columns={[
							{ label: 'Pod', sort: (p: K8sPodView) => p.name },
							{ label: 'Namespace', sort: (p: K8sPodView) => p.namespace },
							{ label: 'Phase', sort: (p: K8sPodView) => p.phase },
							{ label: 'Restarts', sort: (p: K8sPodView) => p.restarts }
						]}
						rows={payload.k8s.podList}
						rowKey={(p: K8sPodView) => `${p.namespace}/${p.name}`}
						searchable
						searchPlaceholder="Filter pods..."
						maxHeight="24rem"
					>
						{#snippet row(p: K8sPodView)}
							<td class="max-w-72 truncate py-1.5 pr-3 font-medium text-fg" title={p.name}
								>{p.name}</td
							>
							<td class="py-1.5 pr-3 text-faint">{p.namespace}</td>
							<td class="py-1.5 pr-3">
								<span
									class={p.phase === 'Running'
										? 'text-up'
										: p.phase === 'Failed'
											? 'text-down'
											: 'text-degraded'}>{p.phase}</span
								>
							</td>
							<td class="py-1.5 font-mono {p.restarts > 0 ? 'text-degraded' : 'text-fg'}"
								>{p.restarts}</td
							>
						{/snippet}
					</DataTable>
				{/if}
			</div>
		{/if}

		{#if payload.services?.length}
			<div class="card mt-4 p-4">
				<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
					<h2 class="text-sm font-medium text-muted">Services ({payload.services.length})</h2>
					<div class="flex gap-1">
						{#each [['all', 'All'], ['failed', `Failed${failedCount ? ` (${failedCount})` : ''}`], ['inactive', 'Inactive']] as [v, label] (v)}
							<button
								class="btn {svcFilter === v ? 'btn-primary' : 'btn-ghost'} !px-2 !py-0.5 text-xs"
								onclick={() => (svcFilter = v as typeof svcFilter)}
							>
								{label}
							</button>
						{/each}
					</div>
				</div>
				<DataTable
					columns={[
						{ label: 'Service', sort: (s: AgentService) => s.name },
						{ label: 'Manager', sort: (s: AgentService) => s.manager },
						{ label: 'State', sort: (s: AgentService) => s.state },
						{
							label: 'Boot',
							sort: (s: AgentService) =>
								s.enabled === undefined ? '' : s.enabled ? 'enabled' : 'disabled'
						},
						...(isAdmin && !agent.revoked ? [{ label: '' }] : [])
					]}
					rows={filteredServices}
					rowKey={(s: AgentService) => s.manager + s.name}
					searchable
					searchPlaceholder="Filter services..."
					maxHeight="24rem"
				>
					{#snippet row(s: AgentService)}
						<td class="max-w-72 truncate py-1.5 pr-3 font-medium text-fg" title={s.name}
							>{s.name}</td
						>
						<td class="py-1.5 pr-3 text-faint">{s.manager}</td>
						<td class="py-1.5 pr-3">
							<span
								class={s.state === 'active'
									? 'text-up'
									: s.state === 'failed'
										? 'text-down'
										: 'text-faint'}>{s.state}{s.sub ? `/${s.sub}` : ''}</span
							>
						</td>
						<td class="py-1.5 text-faint"
							>{s.enabled === undefined ? '' : s.enabled ? 'enabled' : 'disabled'}</td
						>
						{#if isAdmin && agent && !agent.revoked}
							<td class="py-1.5">
								<div class="flex justify-end gap-0.5">
									{#if s.state !== 'active'}
										<button
											class="btn btn-ghost !p-1 text-up"
											title="Start"
											aria-label="Start {s.name}"
											disabled={svcBusy !== null}
											onclick={() => queueSvc('start', s.name)}
										>
											<Play class="size-3.5" />
										</button>
									{/if}
									{#if s.state === 'active'}
										<button
											class="btn btn-ghost !p-1 text-faint"
											title="Restart"
											aria-label="Restart {s.name}"
											disabled={svcBusy !== null}
											onclick={() => queueSvc('restart', s.name)}
										>
											<RotateCw class="size-3.5" />
										</button>
										<button
											class="btn btn-ghost !p-1 text-down"
											title="Stop"
											aria-label="Stop {s.name}"
											disabled={svcBusy !== null}
											onclick={() => queueSvc('stop', s.name)}
										>
											<Square class="size-3.5" />
										</button>
									{/if}
								</div>
							</td>
						{/if}
					{/snippet}
				</DataTable>
			</div>
		{/if}

		{#if payload.processes?.length}
			<div class="card mt-4 p-4">
				<h2 class="mb-3 text-sm font-medium text-muted">Top processes</h2>
				<DataTable
					columns={[
						{ label: 'Process', sort: (p: AgentProcess) => p.name },
						{ label: 'PID', sort: (p: AgentProcess) => p.pid },
						{ label: 'CPU', class: 'text-right', sort: (p: AgentProcess) => p.cpuPct },
						{ label: 'Memory', class: 'text-right', sort: (p: AgentProcess) => p.memBytes }
					]}
					rows={payload.processes}
					rowKey={(p: AgentProcess) => p.pid}
					searchable
					searchPlaceholder="Filter processes..."
				>
					{#snippet row(p: AgentProcess)}
						<td class="max-w-64 truncate py-1.5 pr-3 font-medium text-fg" title={p.name}
							>{p.name}</td
						>
						<td class="py-1.5 pr-3 font-mono text-faint">{p.pid}</td>
						<td
							class="py-1.5 pr-3 text-right font-mono {p.cpuPct >= 50
								? 'text-down'
								: p.cpuPct >= 20
									? 'text-degraded'
									: 'text-fg'}">{p.cpuPct.toFixed(1)}%</td
						>
						<td class="py-1.5 text-right font-mono text-faint">{fmtBytes(p.memBytes)}</td>
					{/snippet}
				</DataTable>
			</div>
		{/if}

		{#if payload.ports?.length}
			<div class="card mt-4 p-4">
				<h2 class="mb-3 text-sm font-medium text-muted">
					Listening ports ({payload.ports.length})
				</h2>
				{#if payload.ports.length > 20}
					<input
						class="input mb-3 text-xs"
						bind:value={portFilter}
						placeholder="Filter by port, address, or process..."
						aria-label="Filter ports"
					/>
				{/if}
				<div class="flex max-h-64 flex-wrap gap-1.5 overflow-y-auto">
					{#each filteredPorts as p (`${p.proto}${p.address}:${p.port}`)}
						<span
							class="rounded-md border border-edge bg-bg px-1.5 py-0.5 font-mono text-xs text-muted"
							title="{p.proto} {p.address}{p.process ? ` · ${p.process}` : ''}"
						>
							{p.port}{p.process ? ` ${p.process}` : ''}
						</span>
					{/each}
				</div>
			</div>
		{/if}
	{:else if !edge}
		<div class="card px-6 py-10 text-center text-sm text-muted">
			No report received yet. Start the agent on the host to populate this page.
		</div>
	{/if}

	{#if edge}
		<div class="card mt-4 p-4">
			<h2 class="mb-3 flex items-center gap-1.5 text-sm font-medium text-muted">
				<Waypoints class="size-4" /> Edge traffic
				<span class="font-normal text-faint"
					>· last {Math.round(edge.windowSec)}s window, {edge.requests} requests</span
				>
			</h2>
			<div class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
				{#each [['2xx', edge.s2xx, 'bg-up'], ['3xx', edge.s3xx, 'bg-maint'], ['4xx', edge.s4xx, 'bg-degraded'], ['5xx', edge.s5xx, 'bg-down'], ['errors', edge.errors?.length ?? 0, 'bg-down']] as [label, n, cls] (label)}
					<div class="rounded-lg border border-edge p-2 text-center">
						<div class="text-lg font-semibold text-fg">{n}</div>
						<div class="flex items-center justify-center gap-1.5 text-xs text-faint">
							<span class="inline-block size-2 rounded-full {cls}"></span>{label}
						</div>
					</div>
				{/each}
			</div>
			{#if edge.latencyP95 !== undefined}
				<p class="mb-4 text-xs text-muted">
					latency p50 {edge.latencyP50?.toFixed(0)}ms · p95 {edge.latencyP95.toFixed(0)}ms · p99 {edge.latencyP99?.toFixed(
						0
					)}ms
				</p>
			{/if}
			{#if edgeSamples.length > 1}
				<div class="mb-4">
					<MetricChart
						series={[
							{
								label: 'requests/window',
								color: '#60a5fa',
								points: edgeSamples.map((s) => ({ ts: s.ts, v: s.requests }))
							},
							{
								label: '5xx',
								color: '#ef4444',
								points: edgeSamples.map((s) => ({ ts: s.ts, v: s.s5xx }))
							}
						]}
					/>
				</div>
			{/if}
			<div class="grid gap-4 lg:grid-cols-2">
				{#if edge.clients?.length}
					<div>
						<h3 class="mb-2 text-xs font-medium text-muted">Top clients</h3>
						<div class="space-y-1">
							{#each edge.clients.slice(0, 10) as c (c.ip)}
								<div class="flex justify-between text-xs">
									<span class="font-mono text-fg">{c.ip}</span>
									<span class="font-mono text-faint">{c.requests}</span>
								</div>
							{/each}
						</div>
					</div>
				{/if}
				{#if edge.paths?.length}
					<div>
						<h3 class="mb-2 text-xs font-medium text-muted">Top paths</h3>
						<div class="space-y-1">
							{#each edge.paths.slice(0, 10) as p (p.path)}
								<div class="flex justify-between gap-2 text-xs">
									<span class="truncate font-mono text-fg" title={p.path}>{p.path}</span>
									<span class="shrink-0 font-mono text-faint"
										>{p.requests}{p.errors > 0 ? ` · ${p.errors} err` : ''}</span
									>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			</div>
			{#if edge.errors?.length}
				<h3 class="mb-2 mt-4 text-xs font-medium text-muted">Recent errors</h3>
				<div class="max-h-64 overflow-y-auto">
					<table class="w-full text-left text-xs">
						<tbody>
							{#each edge.errors.slice(0, 50) as e (`${e.ts}-${e.path}-${e.ip}`)}
								<tr class="border-b border-edge/50 last:border-0">
									<td class="py-1 pr-3 font-mono text-down">{e.status}</td>
									<td class="max-w-56 truncate py-1 pr-3 font-mono text-fg" title="{e.host}{e.path}"
										>{e.method} {e.path}</td
									>
									<td class="py-1 pr-3 font-mono text-faint">{e.ip}</td>
									<td class="py-1 text-faint">{relativeTime(e.ts)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{/if}
{/if}

<Modal bind:open={renameOpen} title="Rename system">
	<form
		class="space-y-4"
		onsubmit={(e) => {
			e.preventDefault();
			void rename();
		}}
	>
		<Field label="Name" required>
			<input class="input w-full" bind:value={renameVal} maxlength="80" required />
		</Field>
		<button class="btn btn-primary w-full" type="submit" disabled={busy || !renameVal.trim()}
			>Save</button
		>
	</form>
</Modal>

<ConfirmDialog
	bind:open={rotateOpen}
	title="Rotate token?"
	description="The current token stops working immediately. The fingerprint binding is cleared so a new or reinstalled host can register. The new token is shown once."
	confirmLabel="Rotate"
	onconfirm={rotate}
/>

<ConfirmDialog
	bind:open={revokeOpen}
	title="Revoke this system?"
	description="The token is revoked and the agent loses access. Sample history is kept. You can rotate later to re-enable it."
	confirmLabel="Revoke"
	danger
	onconfirm={revoke}
/>

<Modal bind:open={rotatedOpen} title="Token rotated" wide>
	{#if rotated}
		{@const r = rotated}
		<p class="text-sm text-muted">Update the agent TOKEN env var. Shown once.</p>
		<div class="mt-3 flex gap-2">
			<code
				class="min-w-0 flex-1 overflow-x-auto rounded-md border border-edge bg-bg px-2 py-1.5 font-mono text-xs"
				>{r.token}</code
			>
			<button
				class="btn btn-ghost shrink-0"
				onclick={() => {
					copy(r.token);
				}}
				aria-label="Copy token"
			>
				<Copy class="size-4" />
			</button>
		</div>
		<button class="btn btn-primary mt-4 w-full" onclick={() => (rotatedOpen = false)}>Done</button>
	{/if}
</Modal>
