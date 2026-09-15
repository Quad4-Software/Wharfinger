<script lang="ts">
	import Modal from '$lib/components/admin/Modal.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import type { AppSource, DeployApp, DeployRuntime, Healthcheck } from '$lib/shared/deploy';
	import { FORGE_KINDS, SOURCE_KINDS, RUNTIMES } from '$lib/shared/deploy';
	import type { ServiceGroup } from '$lib/shared/groups';
	import { api, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';

	// Create/edit form for a deploy app. Emits a plain body the caller
	// posts to the apps API; validation lives server-side. When onsave
	// resolves to the create response (or app is set for edits), group
	// membership is synced through the groups API afterward.
	let {
		open = $bindable(false),
		app = null,
		agents = [],
		onsave
	}: {
		open?: boolean;
		app?: DeployApp | null;
		agents?: { id: string; name: string }[];
		onsave: (body: Record<string, unknown>) => unknown;
	} = $props();

	let name = $state('');
	let agentId = $state('');
	let sourceKind = $state<AppSource['kind']>('git');
	let url = $state('');
	let ref = $state('main');
	let subdir = $state('');
	let forge = $state('auto');
	let pathsText = $state('');
	let submodules = $state(false);
	let lfs = $state(false);
	let previews = $state(false);
	let runtime = $state<DeployRuntime>('podman');
	let namespace = $state('');
	let replicas = $state(1);
	let domainsText = $state('');
	let portsText = $state('');
	let hcEnabled = $state(false);
	let hcKind = $state<'http' | 'tcp'>('http');
	let hcPort = $state(3000);
	let hcPath = $state('/');
	let groups = $state<ServiceGroup[]>([]);
	let groupIds = $state<string[]>([]);
	let branches = $state<string[]>([]);
	let branchesBusy = $state(false);
	let saving = $state(false);

	$effect(() => {
		if (!open) return;
		name = app?.name ?? '';
		agentId = app?.agentId ?? agents.at(0)?.id ?? '';
		sourceKind = app?.source.kind ?? 'git';
		url = app?.source.url ?? '';
		ref = app?.source.ref ?? 'main';
		subdir = app?.source.subdir ?? '';
		forge = app?.source.forge ?? 'auto';
		pathsText = (app?.source.paths ?? []).join(', ');
		submodules = app?.source.submodules ?? false;
		lfs = app?.source.lfs ?? false;
		previews = app?.source.previews ?? false;
		runtime = app?.runtime ?? 'podman';
		namespace = app?.namespace ?? '';
		replicas = app?.replicas ?? 1;
		domainsText = (app?.domains ?? []).join(', ');
		portsText = (app?.ports ?? []).map((p) => `${p.host}:${p.container}`).join(', ');
		hcEnabled = Boolean(app?.healthcheck.port);
		hcKind = app?.healthcheck.kind ?? 'http';
		hcPort = app?.healthcheck.port ?? 3000;
		hcPath = app?.healthcheck.path ?? '/';
		groupIds = [];
		branches = [];
		// The groups endpoint needs groups.manage; without it the picker
		// simply stays hidden.
		void api<{ groups: ServiceGroup[] }>('/groups')
			.then((r) => {
				groups = r.groups;
				if (app) {
					groupIds = r.groups
						.filter((g) => g.members.some((m) => m.memberKind === 'app' && m.memberId === app.id))
						.map((g) => g.id);
				}
			})
			.catch(() => {
				groups = [];
			});
	});

	function toggleGroup(id: string): void {
		groupIds = groupIds.includes(id) ? groupIds.filter((g) => g !== id) : [...groupIds, id];
	}

	function appIdFrom(res: unknown): string | null {
		if (res === null || typeof res !== 'object') return null;
		const a = (res as { app?: unknown }).app;
		if (a === null || typeof a !== 'object') return null;
		const id = (a as { id?: unknown }).id;
		return typeof id === 'string' ? id : null;
	}

	// The deploy apps API is owned elsewhere, so membership is written
	// through the groups API once the app id is known.
	async function syncGroups(appId: string): Promise<void> {
		const member = { memberKind: 'app' as const, memberId: appId };
		const ops: Promise<unknown>[] = [];
		for (const g of groups) {
			const has = g.members.some((m) => m.memberKind === 'app' && m.memberId === appId);
			const want = groupIds.includes(g.id);
			if (has === want) continue;
			ops.push(
				api(`/groups/${g.id}/members`, {
					method: 'PUT',
					body: has ? { add: [], remove: [member] } : { add: [member], remove: [] }
				})
			);
		}
		await Promise.all(ops);
	}

	// Branch browse uses the app's stored forge token server-side, so
	// it only exists when editing an existing app.
	async function loadBranches(): Promise<void> {
		if (!app) return;
		branchesBusy = true;
		try {
			const res = await api<{ branches: string[] }>(`/deploy/apps/${app.id}/branches`);
			branches = res.branches;
			if (!res.branches.length) toast('info', 'no branches returned by the forge');
		} catch (err) {
			toast('error', errMessage(err, 'branch listing failed').slice(0, 300));
		} finally {
			branchesBusy = false;
		}
	}

	// "host:container, host2:container2" -> PortMap[]; invalid pairs
	// abort the save with a toast rather than posting a bad body.
	function parsePorts(text: string): { host: number; container: number }[] | null {
		const out: { host: number; container: number }[] = [];
		for (const tok of text.split(',')) {
			const t = tok.trim();
			if (!t) continue;
			const m = /^(\d{1,5}):(\d{1,5})$/.exec(t);
			const host = m ? Number(m[1]) : NaN;
			const container = m ? Number(m[2]) : NaN;
			if (!m || host < 1 || host > 65535 || container < 1 || container > 65535) {
				return null;
			}
			out.push({ host, container });
		}
		return out;
	}

	async function save(): Promise<void> {
		const ports = parsePorts(portsText);
		if (ports === null) {
			toast('error', 'ports must be host:container pairs, e.g. 8080:80');
			return;
		}
		const source: AppSource = { kind: sourceKind };
		if (url.trim()) source.url = url.trim();
		if (sourceKind === 'git' || sourceKind === 'static') {
			if (ref.trim()) source.ref = ref.trim();
			if (subdir.trim()) source.subdir = subdir.trim();
		}
		if (sourceKind === 'git') {
			if (forge !== 'auto') source.forge = forge as AppSource['forge'];
			const paths = pathsText
				.split(',')
				.map((p) => p.trim())
				.filter(Boolean);
			if (paths.length) source.paths = paths;
			if (submodules) source.submodules = true;
			if (lfs) source.lfs = true;
			if (previews) source.previews = true;
		}
		const healthcheck: Partial<Healthcheck> = hcEnabled
			? { kind: hcKind, port: hcPort, path: hcPath || '/' }
			: {};
		saving = true;
		try {
			const res = await onsave({
				name: name.trim().toLowerCase(),
				agentId,
				source,
				runtime,
				...(runtime === 'k8s'
					? { namespace: namespace.trim() || null, replicas }
					: { namespace: null, replicas: null }),
				domains: domainsText
					.split(',')
					.map((d) => d.trim())
					.filter(Boolean),
				ports,
				healthcheck
			});
			const appId = app?.id ?? appIdFrom(res);
			if (appId && groups.length > 0) {
				await syncGroups(appId).catch((err: unknown) => {
					toast('error', `group assignment failed: ${errMessage(err)}`);
				});
			}
		} finally {
			saving = false;
		}
	}
</script>

<Modal bind:open title={app ? `Edit ${app.name}` : 'New application'} wide>
	<form
		class="space-y-4"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<div class="grid gap-4 sm:grid-cols-2">
			<Field label="Name" hint="Lowercase dns-label; used in container names" required>
				<input class="input" bind:value={name} placeholder="my-app" required />
			</Field>
			<Field label="Target system" hint="Agent that builds and runs the workload" required>
				<select class="input" bind:value={agentId} required>
					{#each agents as a (a.id)}
						<option value={a.id}>{a.name}</option>
					{/each}
				</select>
			</Field>
		</div>

		<div class="grid gap-4 sm:grid-cols-2">
			<Field label="Source">
				<select class="input" bind:value={sourceKind}>
					{#each SOURCE_KINDS as k (k)}
						<option value={k}>{k}</option>
					{/each}
				</select>
			</Field>
			<Field label="Runtime" hint="Podman is the default; k8s needs a kubeconfig on the agent">
				<select class="input" bind:value={runtime}>
					{#each RUNTIMES as rt (rt)}
						<option value={rt}>{rt}</option>
					{/each}
				</select>
			</Field>
		</div>

		{#if runtime === 'k8s'}
			<div class="grid gap-4 sm:grid-cols-2">
				<Field label="Namespace" hint="Optional DNS-1123 label; empty uses the agent default">
					<input class="input" bind:value={namespace} placeholder="default" />
				</Field>
				<Field label="Replicas" hint="Pod count, 1-10">
					<input class="input" type="number" min="1" max="10" bind:value={replicas} />
				</Field>
			</div>
		{/if}

		<Field
			label={sourceKind === 'image' ? 'Image reference' : 'Repository URL'}
			hint={sourceKind === 'image'
				? 'Registry reference, for example registry.example.com/app:latest'
				: 'https, ssh://, or git@ clone URL'}
			required
		>
			<input class="input" bind:value={url} placeholder="git@github.com:org/repo.git" required />
		</Field>

		{#if sourceKind !== 'image'}
			<div class="grid gap-4 sm:grid-cols-2">
				<Field label="Ref" hint="Branch, tag, or commit">
					<div class="flex gap-2">
						<input
							class="input"
							bind:value={ref}
							placeholder="main"
							list={app && branches.length ? 'wf-branches' : undefined}
						/>
						{#if app && sourceKind === 'git'}
							<button
								type="button"
								class="btn shrink-0"
								onclick={() => void loadBranches()}
								disabled={branchesBusy}
							>
								{branchesBusy ? 'loading' : 'browse'}
							</button>
							<datalist id="wf-branches">
								{#each branches as b (b)}
									<option value={b}></option>
								{/each}
							</datalist>
						{/if}
					</div>
				</Field>
				<Field label="Subdirectory" hint="Optional path inside the repo">
					<input class="input" bind:value={subdir} placeholder="apps/web" />
				</Field>
			</div>
		{/if}

		{#if sourceKind === 'git'}
			<div class="grid gap-4 sm:grid-cols-2">
				<Field
					label="Forge"
					hint="Drives commit-status posts; auto detects github/gitlab/gitea hosts"
				>
					<select class="input" bind:value={forge}>
						<option value="auto">auto</option>
						{#each FORGE_KINDS as f (f)}
							<option value={f}>{f}</option>
						{/each}
					</select>
				</Field>
				<Field
					label="Path filters"
					hint="Comma-separated globs; push deploys only when a touched path matches"
				>
					<input class="input font-mono" bind:value={pathsText} placeholder="apps/web, libs/**" />
				</Field>
			</div>
			<div class="flex gap-5 text-sm">
				<label class="flex items-center gap-2">
					<input type="checkbox" bind:checked={submodules} /> Submodules
				</label>
				<label class="flex items-center gap-2">
					<input type="checkbox" bind:checked={lfs} /> Git LFS
				</label>
				<label class="flex items-center gap-2">
					<input type="checkbox" bind:checked={previews} /> PR previews
				</label>
			</div>
			{#if previews}
				<p class="text-xs text-degraded">
					PR previews run pull-request code with this app's env, forge token, and deploy key. Enable
					only for repos whose contributors you trust.
				</p>
			{/if}
		{/if}

		<div class="grid gap-4 sm:grid-cols-2">
			<Field label="Domains" hint="Comma-separated hostnames routed by the edge proxy">
				<input
					class="input"
					bind:value={domainsText}
					placeholder="app.example.com, www.example.com"
				/>
			</Field>
			<Field
				label="Ports"
				hint="host:container pairs; first one is the edge upstream and the k8s service port. With domains but no ports the healthcheck port is published"
			>
				<input class="input font-mono" bind:value={portsText} placeholder="8080:80, 9090:90" />
			</Field>
		</div>

		{#if groups.length > 0}
			<Field label="Groups" hint="Optional admin-managed groups for dashboard filtering">
				<div class="flex flex-wrap gap-1.5">
					{#each groups as g (g.id)}
						<button
							type="button"
							class="chip flex cursor-pointer items-center gap-1.5 py-1 {groupIds.includes(g.id)
								? 'chip-on'
								: ''}"
							aria-pressed={groupIds.includes(g.id)}
							onclick={() => {
								toggleGroup(g.id);
							}}
						>
							{#if g.color}
								<span
									class="size-2 rounded-full"
									style="background-color: {g.color}"
									aria-hidden="true"
								></span>
							{/if}
							{g.name}
						</button>
					{/each}
				</div>
			</Field>
		{/if}

		<div class="rounded-lg border border-edge p-3">
			<label class="flex items-center gap-2 text-sm font-medium">
				<input type="checkbox" bind:checked={hcEnabled} />
				Health check
			</label>
			{#if hcEnabled}
				<div class="mt-3 grid gap-3 sm:grid-cols-3">
					<Field label="Kind">
						<select class="input" bind:value={hcKind}>
							<option value="http">http</option>
							<option value="tcp">tcp</option>
						</select>
					</Field>
					<Field label="Port">
						<input class="input" type="number" min="1" max="65535" bind:value={hcPort} />
					</Field>
					{#if hcKind === 'http'}
						<Field label="Path">
							<input class="input" bind:value={hcPath} placeholder="/" />
						</Field>
					{/if}
				</div>
			{/if}
		</div>

		<div class="flex justify-end gap-2 pt-1">
			<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={saving}>
				{app ? 'Save' : 'Create'}
			</button>
		</div>
	</form>
</Modal>
