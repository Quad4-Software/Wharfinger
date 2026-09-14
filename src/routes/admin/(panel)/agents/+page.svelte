<script lang="ts">
	import { onMount } from 'svelte';
	import { useInterval } from 'runed';
	import { Copy, Plus, RefreshCw, Server } from '@lucide/svelte';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import Modal from '$lib/components/admin/Modal.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import GaugeBar from '$lib/components/admin/GaugeBar.svelte';
	import { adminHref, api, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';
	import { fmtPct, fmtRate, fmtUptime, relativeTime } from '$lib/utils/format';
	import type { AgentView } from '$lib/shared/agents';

	let agents = $state<AgentView[]>([]);
	let pubkey = $state('');
	let ingressEnabled = $state(true);
	let loading = $state(true);
	let releases = $state<{ name: string; version: string; sha256: string; size: number }[]>([]);
	let relVersion = $state('');
	let relFile = $state<FileList | null>(null);
	let relBusy = $state(false);
	let addOpen = $state(false);
	let newName = $state('');
	let selfUpdate = $state(false);
	let creating = $state(false);
	let created = $state<{
		id: string;
		token: string;
		pubkey: string;
		ingress: string;
		ws: string;
	} | null>(null);

	async function load(): Promise<void> {
		try {
			const r = await api<{ agents: AgentView[]; pubkey: string; enabled: boolean }>('/agents');
			agents = r.agents;
			pubkey = r.pubkey;
			ingressEnabled = r.enabled;
		} catch (err) {
			toast('error', errMessage(err));
		} finally {
			loading = false;
		}
	}

	async function loadReleases(): Promise<void> {
		try {
			const r = await api<{
				files: { name: string; version: string; sha256: string; size: number }[];
			}>('/agent-release');
			releases = r.files;
		} catch {
			// Older hub or no permission; the card just stays empty.
		}
	}

	async function uploadRelease(): Promise<void> {
		const file = relFile?.[0];
		if (!file || !relVersion.trim()) return;
		relBusy = true;
		try {
			await api(
				`/agent-release?name=${encodeURIComponent(file.name)}&version=${encodeURIComponent(relVersion.trim())}`,
				{ method: 'POST', rawBody: await file.arrayBuffer() }
			);
			toast('success', `${file.name} hosted`);
			relVersion = '';
			relFile = null;
			await loadReleases();
		} catch (err) {
			toast('error', errMessage(err));
		} finally {
			relBusy = false;
		}
	}

	async function deleteRelease(name: string): Promise<void> {
		try {
			await api(`/agent-release?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
			toast('success', `${name} removed`);
			await loadReleases();
		} catch (err) {
			toast('error', errMessage(err));
		}
	}

	onMount(() => {
		void load();
		void loadReleases();
	});
	useInterval(() => 15_000, { callback: () => void load() });

	async function create(): Promise<void> {
		if (!newName.trim()) return;
		creating = true;
		try {
			created = await api('/agents', { body: { name: newName.trim() } });
			toast('success', `System "${newName.trim()}" registered`);
			await load();
		} catch (err) {
			toast('error', errMessage(err));
		} finally {
			creating = false;
		}
	}

	function copy(text: string, what: string): void {
		navigator.clipboard
			.writeText(text)
			.then(() => {
				toast('success', `${what} copied`);
			})
			.catch(() => {
				toast('error', 'copy failed');
			});
	}

	function closeAdd(): void {
		addOpen = false;
	}

	// Attention-first ordering: revoked sinks, then offline and
	// alerting systems, then worst current metric.
	function score(a: AgentView): number {
		if (a.revoked) return -1;
		let s = a.online ? 0 : 2000;
		s += a.alerts.length * 500;
		if (a.summary) {
			s += Math.max(a.summary.cpuPct, a.summary.memPct, a.summary.diskPct ?? 0);
		}
		return s;
	}
	const sorted = $derived([...agents].sort((a, b) => score(b) - score(a)));

	// Highest agent version in the fleet; anything below it gets an
	// update hint. Versions may arrive as v0.1.0 or 0.1.0.
	function cmpVersion(a: string, b: string): number {
		const pa = a
			.replace(/^v/, '')
			.split('.')
			.map((n) => parseInt(n, 10) || 0);
		const pb = b
			.replace(/^v/, '')
			.split('.')
			.map((n) => parseInt(n, 10) || 0);
		for (let i = 0; i < 3; i++) {
			if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
		}
		return 0;
	}
	const latestVersion = $derived(
		agents
			.map((a) => a.meta?.version)
			.filter((v): v is string => !!v)
			.sort(cmpVersion)
			.at(-1) ?? null
	);

	$effect(() => {
		if (!addOpen) {
			created = null;
			newName = '';
			selfUpdate = false;
		}
	});

	const installCmd = $derived(
		created
			? `curl -fsSL https://github.com/Quad4-Software/Wharfinger/releases/latest/download/install.sh | sh -s -- --hub ${new URL(created.ingress).origin} --token ${created.token} --key ${created.pubkey}${selfUpdate ? ' --self-update' : ''}`
			: ''
	);
	const manualCmd = $derived(
		created
			? `HUB_URL=${new URL(created.ingress).origin} TOKEN=${created.token} KEY=${created.pubkey} wharfinger-agent`
			: ''
	);
	const dockerCmd = $derived(
		created
			? `docker run -d --name wharfinger-agent --restart unless-stopped --network host \\
  -e HUB_URL=${new URL(created.ingress).origin} \\
  -e TOKEN=${created.token} -e KEY=${created.pubkey} \\
  -v /proc:/host/proc:ro -v /sys:/host/sys:ro \\
  -v /var/run/docker.sock:/var/run/docker.sock:ro \\
  ghcr.io/quad4-software/wharfinger-agent:latest`
			: ''
	);
</script>

<PageHeader title="Systems" description="Remote hosts reporting through the agent.">
	<button class="btn btn-ghost" onclick={load} disabled={loading} aria-label="Refresh">
		<RefreshCw class="size-4 {loading ? 'animate-spin' : ''}" />
	</button>
	<button
		class="btn btn-primary"
		onclick={() => (addOpen = true)}
		disabled={!ingressEnabled}
		title={ingressEnabled ? 'Register a system' : 'Ingress is disabled in config'}
	>
		<Plus class="size-4" /> Add system
	</button>
</PageHeader>

{#if !ingressEnabled}
	<div class="card mb-4 border-degraded/40 px-4 py-3 text-sm text-degraded">
		Ingress is disabled in the <code class="font-mono">[ingress]</code> config section; agents cannot
		connect until it is enabled.
	</div>
{/if}

{#if loading && agents.length === 0}
	<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
		{#each [0, 1, 2] as i (i)}
			<div class="card h-36 animate-pulse"></div>
		{/each}
	</div>
{:else if agents.length === 0}
	<div class="card flex flex-col items-center gap-3 px-6 py-12 text-center">
		<Server class="size-8 text-faint" />
		<p class="text-sm text-muted">
			No systems registered yet. Add one to get a bearer token, then run the agent on the host.
		</p>
		<button class="btn btn-primary" onclick={() => (addOpen = true)} disabled={!ingressEnabled}>
			<Plus class="size-4" /> Add your first system
		</button>
	</div>
{:else}
	<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
		{#each sorted as a (a.id)}
			<a
				href={adminHref(`/agents/${a.id}`)}
				class="card group px-4 py-3 transition-colors hover:border-accent/50"
			>
				<div class="flex items-center justify-between gap-2">
					<div class="flex min-w-0 items-center gap-2">
						<span
							class="size-2 shrink-0 rounded-full {a.revoked
								? 'bg-faint'
								: a.online
									? 'bg-up'
									: 'bg-down'}"
							title={a.revoked ? 'revoked' : a.online ? 'online' : 'offline'}
						></span>
						<span class="truncate font-medium text-fg group-hover:text-accent">{a.name}</span>
						{#if a.alerts.length > 0}
							<span
								class="shrink-0 animate-pulse rounded bg-down/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-down"
								title="Active alerts: {a.alerts.join(', ')}">alerting</span
							>
						{/if}
						{#if !a.keyBound}
							<span
								class="shrink-0 rounded bg-degraded/15 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-degraded"
								title="No identity key bound: pre-keypair (legacy) agent">legacy</span
							>
						{/if}
					</div>
					<span class="shrink-0 text-xs text-faint">
						{a.revoked ? 'revoked' : a.lastSeenAt ? relativeTime(a.lastSeenAt) : 'never seen'}
					</span>
				</div>
				{#if a.meta}
					<p class="mt-0.5 flex items-center gap-1.5 truncate text-xs text-faint">
						<span class="truncate"
							>{a.meta.hostname ?? ''} · {a.meta.os ?? ''}/{a.meta.arch ?? ''} · agent {a.meta
								.version ?? '?'}</span
						>
						{#if latestVersion && a.meta.version && cmpVersion(a.meta.version, latestVersion) < 0}
							<span
								class="shrink-0 rounded bg-degraded/15 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-degraded"
								title="Latest agent in the fleet: {latestVersion}">update</span
							>
						{/if}
					</p>
				{/if}
				{#if a.summary}
					<div class="mt-3 space-y-2">
						<GaugeBar
							pct={a.summary.cpuPct}
							label="CPU"
							detail={fmtPct(a.summary.cpuPct)}
							compact
						/>
						<GaugeBar
							pct={a.summary.memPct}
							label="Memory"
							detail={fmtPct(a.summary.memPct)}
							compact
						/>
						{#if a.summary.diskPct !== null}
							<GaugeBar
								pct={a.summary.diskPct}
								label="Disk"
								detail={fmtPct(a.summary.diskPct)}
								compact
							/>
						{/if}
					</div>
					<div class="mt-2.5 flex items-center justify-between text-xs text-faint">
						<span>
							rx {fmtRate(a.summary.rxBps)} · tx {fmtRate(a.summary.txBps)}
						</span>
						<span>up {fmtUptime(a.summary.uptimeSec)}</span>
					</div>
				{:else}
					<p class="mt-3 text-xs text-faint">Waiting for the first report.</p>
				{/if}
			</a>
		{/each}
	</div>
{/if}

<section class="card mt-6 p-5">
	<h2 class="mb-1 text-sm font-semibold">Hosted agent releases</h2>
	<p class="mb-3 text-xs text-faint">
		Binaries uploaded here are served at
		<code class="font-mono">/api/agent-release/manifest</code>. Air-gapped agents can update from
		the hub by setting <code class="font-mono">UPDATE_MANIFEST</code> to that URL instead of reaching
		GitHub. The agent verifies the advertised sha256 before installing.
	</p>
	{#if releases.length > 0}
		<ul class="mb-3 space-y-1.5">
			{#each releases as f (f.name)}
				<li class="flex items-center justify-between gap-2 text-sm">
					<span class="min-w-0 truncate font-mono text-xs">
						{f.name}
						<span class="text-faint"
							>v{f.version.replace(/^v/, '')} · {(f.size / 1048576).toFixed(1)} MB · sha256 {f.sha256.slice(
								0,
								12
							)}…</span
						>
					</span>
					<button
						class="btn btn-ghost btn-sm shrink-0 text-xs text-down"
						onclick={() => void deleteRelease(f.name)}>Remove</button
					>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="mb-3 text-xs text-faint">No binaries hosted yet.</p>
	{/if}
	<form
		class="flex flex-wrap items-end gap-2"
		onsubmit={(e) => {
			e.preventDefault();
			void uploadRelease();
		}}
	>
		<label class="min-w-48 flex-1 text-xs text-muted">
			Binary
			<input type="file" class="input mt-1 w-full text-xs" bind:files={relFile} required />
		</label>
		<label class="w-32 text-xs text-muted">
			Version
			<input
				class="input mt-1 w-full font-mono"
				bind:value={relVersion}
				placeholder="0.2.0"
				required
			/>
		</label>
		<button class="btn" type="submit" disabled={relBusy || !relFile?.[0] || !relVersion.trim()}>
			{relBusy ? 'Uploading…' : 'Upload'}
		</button>
	</form>
</section>

<Modal bind:open={addOpen} title={created ? 'System registered' : 'Add system'} wide>
	{#if created}
		{@const c = created}
		<p class="text-sm text-muted">
			Copy the token now; it is shown once and only its hash is stored.
		</p>
		<div class="mt-3 space-y-3">
			<Field label="Bearer token">
				<div class="flex gap-2">
					<code
						class="min-w-0 flex-1 overflow-x-auto rounded-md border border-edge bg-bg px-2 py-1.5 font-mono text-xs"
						>{c.token}</code
					>
					<button
						class="btn btn-ghost shrink-0"
						onclick={() => {
							copy(c.token, 'Token');
						}}
						aria-label="Copy token"
					>
						<Copy class="size-4" />
					</button>
				</div>
			</Field>
			<Field
				label="Hub public key"
				hint="Configure on the agent as KEY to verify the hub during the ws handshake."
			>
				<div class="flex gap-2">
					<code
						class="min-w-0 flex-1 overflow-x-auto rounded-md border border-edge bg-bg px-2 py-1.5 font-mono text-xs"
						>{c.pubkey}</code
					>
					<button
						class="btn btn-ghost shrink-0"
						onclick={() => {
							copy(c.pubkey, 'Key');
						}}
						aria-label="Copy key"
					>
						<Copy class="size-4" />
					</button>
				</div>
			</Field>
			<label class="flex items-center gap-2 text-sm text-muted">
				<input type="checkbox" class="accent-accent" bind:checked={selfUpdate} />
				Enable the auto-updater
				<span class="text-xs text-faint">
					(periodic checksum-verified upgrades; the service restarts on the new binary)
				</span>
			</label>
			<Field
				label="One-line install"
				hint="Downloads the binary, verifies its checksum, and installs a systemd or OpenRC service."
			>
				<div class="flex gap-2">
					<code
						class="min-w-0 flex-1 overflow-x-auto rounded-md border border-edge bg-bg px-2 py-1.5 font-mono text-xs"
						>{installCmd}</code
					>
					<button
						class="btn btn-ghost shrink-0"
						onclick={() => {
							copy(installCmd, 'Command');
						}}
						aria-label="Copy command"
					>
						<Copy class="size-4" />
					</button>
				</div>
			</Field>
			<Field label="Run manually">
				<div class="flex gap-2">
					<code
						class="min-w-0 flex-1 overflow-x-auto rounded-md border border-edge bg-bg px-2 py-1.5 font-mono text-xs"
						>{manualCmd}</code
					>
					<button
						class="btn btn-ghost shrink-0"
						onclick={() => {
							copy(manualCmd, 'Command');
						}}
						aria-label="Copy command"
					>
						<Copy class="size-4" />
					</button>
				</div>
			</Field>
			<Field label="Docker">
				<div class="flex gap-2">
					<pre
						class="min-w-0 flex-1 overflow-x-auto rounded-md border border-edge bg-bg px-2 py-1.5 font-mono text-xs">{dockerCmd}</pre>
					<button
						class="btn btn-ghost shrink-0"
						onclick={() => {
							copy(dockerCmd, 'Command');
						}}
						aria-label="Copy docker command"
					>
						<Copy class="size-4" />
					</button>
				</div>
			</Field>
			<button class="btn btn-primary w-full" onclick={closeAdd}>Done</button>
		</div>
	{:else}
		<form
			class="space-y-4"
			onsubmit={(e) => {
				e.preventDefault();
				void create();
			}}
		>
			<Field label="System name" required hint="A display name for this host, e.g. web-1 or nas.">
				<input class="input w-full" bind:value={newName} maxlength="80" required />
			</Field>
			{#if pubkey}
				<Field
					label="Hub public key"
					hint="The agent needs this as KEY to verify the hub during the ws handshake."
				>
					<div class="flex gap-2">
						<code
							class="min-w-0 flex-1 overflow-x-auto rounded-md border border-edge bg-bg px-2 py-1.5 font-mono text-xs"
							>{pubkey}</code
						>
						<button
							type="button"
							class="btn btn-ghost shrink-0"
							onclick={() => {
								copy(pubkey, 'Key');
							}}
							aria-label="Copy key"
						>
							<Copy class="size-4" />
						</button>
					</div>
				</Field>
			{/if}
			<button class="btn btn-primary w-full" type="submit" disabled={creating || !newName.trim()}>
				{creating ? 'Registering…' : 'Register'}
			</button>
		</form>
	{/if}
</Modal>
