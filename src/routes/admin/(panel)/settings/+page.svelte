<script lang="ts">
	import { onMount } from 'svelte';
	import { Download, Link2, Plus, Trash, Upload } from '@lucide/svelte';
	import PageHeader from '$lib/components/admin/PageHeader.svelte';
	import SectionChip from '$lib/components/admin/SectionChip.svelte';
	import SaveBar from '$lib/components/admin/SaveBar.svelte';
	import Field from '$lib/components/admin/Field.svelte';
	import { api, ApiError, errMessage } from '$lib/state/admin.svelte';
	import { toast } from '$lib/state/toasts.svelte';

	type Dict = Record<string, unknown>;
	interface View {
		value: unknown;
		overridden: boolean;
		updatedAt: number | null;
	}

	interface Sec {
		loaded: Dict | unknown[];
		draft: Dict | unknown[];
		overridden: boolean;
		updatedAt: number | null;
		saving: boolean;
	}

	const KEYS = ['site', 'page', 'monitor', 'admin', 'links', 'telemetry'] as const;
	type Key = (typeof KEYS)[number];

	const secs = $state<Record<Key, Sec>>({
		site: { loaded: {}, draft: {}, overridden: false, updatedAt: null, saving: false },
		page: { loaded: {}, draft: {}, overridden: false, updatedAt: null, saving: false },
		monitor: { loaded: {}, draft: {}, overridden: false, updatedAt: null, saving: false },
		admin: { loaded: {}, draft: {}, overridden: false, updatedAt: null, saving: false },
		links: { loaded: [], draft: [], overridden: false, updatedAt: null, saving: false },
		telemetry: { loaded: {}, draft: {}, overridden: false, updatedAt: null, saving: false }
	});

	let toml = $state('');
	let tomlLoaded = $state('');
	let tomlOverrides = $state<string[]>([]);
	let tomlSaving = $state(false);
	let loading = $state(true);
	let testing = $state(false);

	const tomlDirty = $derived(toml !== tomlLoaded);

	function obj(k: Key): Dict {
		return secs[k].draft as Dict;
	}
	function set(k: Key, patch: Dict): void {
		secs[k].draft = { ...(secs[k].draft as Dict), ...patch };
	}
	function links(): { label: string; href: string }[] {
		return secs.links.draft as { label: string; href: string }[];
	}
	function dirty(k: Key): boolean {
		return JSON.stringify(secs[k].draft) !== JSON.stringify(secs[k].loaded);
	}

	async function load(): Promise<void> {
		try {
			const results = await Promise.all(KEYS.map((k) => api<View>(`/sections/${k}`)));
			KEYS.forEach((k, i) => {
				const v = (results[i].value ?? (k === 'links' ? [] : {})) as Dict | unknown[];
				secs[k] = {
					loaded: structuredClone(v),
					draft: structuredClone(v),
					overridden: results[i].overridden,
					updatedAt: results[i].updatedAt,
					saving: false
				};
			});
			const t = await api<{ toml: string; overrides: string[] }>('/config/toml');
			toml = t.toml;
			tomlLoaded = t.toml;
			tomlOverrides = t.overrides;
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'load failed');
		} finally {
			loading = false;
		}
	}

	onMount(load);

	async function save(k: Key): Promise<void> {
		secs[k].saving = true;
		try {
			const r = await api<{ overridden: boolean; updatedAt: number | null }>(`/sections/${k}`, {
				method: 'PUT',
				body: { value: secs[k].draft, expected: secs[k].updatedAt }
			});
			secs[k].loaded = structuredClone(secs[k].draft);
			secs[k].overridden = r.overridden;
			secs[k].updatedAt = r.updatedAt;
			toast('success', `${k} applied`);
		} catch (err) {
			toast('error', errMessage(err, 'save failed').slice(0, 400));
		} finally {
			secs[k].saving = false;
		}
	}

	async function saveToml(): Promise<void> {
		tomlSaving = true;
		try {
			const r = await api<{ overrides: string[] }>('/config/toml', {
				method: 'PUT',
				body: { toml }
			});
			tomlLoaded = toml;
			tomlOverrides = r.overrides;
			toast('success', 'Config applied');
			await load();
		} catch (err) {
			toast('error', errMessage(err, 'save failed').slice(0, 400));
		} finally {
			tomlSaving = false;
		}
	}

	async function sendTest(): Promise<void> {
		testing = true;
		try {
			await api('/telemetry/test', { method: 'POST' });
			toast('success', 'Test event delivered');
		} catch (err) {
			toast('error', errMessage(err, 'test event failed').slice(0, 400));
		} finally {
			testing = false;
		}
	}

	function addLink(): void {
		secs.links.draft = [...links(), { label: '', href: 'https://' }];
	}
	function removeLink(i: number): void {
		secs.links.draft = links().filter((_, j) => j !== i);
	}
	function setLink(i: number, patch: Partial<{ label: string; href: string }>): void {
		secs.links.draft = links().map((l, j) => (j === i ? { ...l, ...patch } : l));
	}

	function num(v: unknown): number | string {
		return typeof v === 'number' ? v : '';
	}
	function str(v: unknown): string {
		return typeof v === 'string' ? v : '';
	}
	function bool(v: unknown, dflt: boolean): boolean {
		return typeof v === 'boolean' ? v : dflt;
	}

	const NAV: { key: Key | 'toml' | 'backup'; label: string }[] = [
		{ key: 'site', label: 'Site' },
		{ key: 'page', label: 'Status page' },
		{ key: 'monitor', label: 'Monitor' },
		{ key: 'links', label: 'Links' },
		{ key: 'admin', label: 'Panel' },
		{ key: 'telemetry', label: 'Telemetry' },
		{ key: 'toml', label: 'Raw config' },
		{ key: 'backup', label: 'Backup' }
	];
	const dirtyKeys = $derived(KEYS.filter((k) => dirty(k)));
	const anyDirty = $derived(dirtyKeys.length > 0 || tomlDirty);

	function navDirty(key: Key | 'toml' | 'backup'): boolean {
		if (key === 'toml') return tomlDirty;
		if (key === 'backup') return false;
		return dirty(key);
	}
	function jumpTo(key: string): void {
		document.getElementById(`sec-${key}`)?.scrollIntoView({ behavior: 'smooth' });
	}
	async function saveAll(): Promise<void> {
		for (const k of dirtyKeys) await save(k);
		if (tomlDirty) await saveToml();
	}

	let backupBusy = $state(false);
	let backupMerge = $state(false);
	let backupResult = $state('');
	let exportPassphrase = $state('');
	let importPassphrase = $state('');

	async function exportBackup(): Promise<void> {
		backupBusy = true;
		try {
			// A passphrase export rides POST so the secret stays out of the
			// request URL; empty means a plaintext export.
			const data = exportPassphrase
				? await api('/backup', { body: { passphrase: exportPassphrase } })
				: await api('/backup');
			const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
			const a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = `status-backup-${new Date().toISOString().slice(0, 10)}.json`;
			a.click();
			URL.revokeObjectURL(a.href);
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : 'export failed');
		} finally {
			backupBusy = false;
		}
	}

	async function importBackup(file: File | undefined): Promise<void> {
		if (!file || backupBusy) return;
		backupBusy = true;
		backupResult = '';
		try {
			const raw: unknown = JSON.parse(await file.text());
			if (
				typeof raw !== 'object' ||
				raw === null ||
				(!('config' in raw) && !('encrypted' in raw))
			) {
				throw new Error('not a wharfinger backup file');
			}
			const rec = raw as Record<string, unknown>;
			if ('encrypted' in rec && !importPassphrase) {
				throw new Error('this backup is encrypted; enter its passphrase first');
			}
			const r = await api<{ applied: string[]; failed: { section: string; error: string }[] }>(
				'/backup',
				{
					body: {
						config: rec.encrypted ?? rec.config,
						mode: backupMerge ? 'merge' : 'replace',
						passphrase: importPassphrase || undefined
					}
				}
			);
			backupResult = `applied: ${r.applied.join(', ') || 'none'}\nfailed: ${
				r.failed.map((f) => `${f.section} (${f.error})`).join(', ') || 'none'
			}`;
			toast(r.failed.length === 0 ? 'success' : 'error', 'Import finished');
			await load();
		} catch (err) {
			toast('error', err instanceof ApiError ? err.message : errMessage(err));
		} finally {
			backupBusy = false;
		}
	}
</script>

<PageHeader title="Settings" description="Site identity, monitor tuning, and panel policy">
	{#if anyDirty}
		<button class="btn btn-primary" onclick={() => void saveAll()}>
			Save all ({dirtyKeys.length + (tomlDirty ? 1 : 0)})
		</button>
	{/if}
</PageHeader>

{#if loading}
	<div class="space-y-6">
		<div class="card h-40 animate-pulse"></div>
		<div class="card h-40 animate-pulse"></div>
	</div>
{:else}
	<div class="xl:flex xl:items-start xl:gap-6">
		<nav
			class="mb-4 flex flex-wrap gap-1 xl:sticky xl:top-4 xl:mb-0 xl:w-40 xl:shrink-0 xl:flex-col"
			aria-label="Settings sections"
		>
			{#each NAV as n (n.key)}
				<button
					class="btn btn-ghost justify-start !px-2.5 !py-1.5 text-xs {navDirty(n.key)
						? 'text-accent'
						: 'text-muted'}"
					onclick={() => {
						jumpTo(n.key);
					}}
				>
					<span class="size-1.5 rounded-full {navDirty(n.key) ? 'bg-accent' : 'bg-transparent'}"
					></span>
					{n.label}
				</button>
			{/each}
		</nav>
		<div class="min-w-0 flex-1 space-y-6">
			<!-- Site -->
			<section id="sec-site" class="card scroll-mt-4 p-5">
				<div class="mb-4 flex items-center justify-between">
					<h2 class="text-sm font-semibold">Site</h2>
					<SectionChip section="site" overridden={secs.site.overridden} onreset={load} />
				</div>
				<div class="grid gap-3 sm:grid-cols-2">
					<Field label="Name" required
						><input
							class="input"
							value={str(obj('site').name)}
							oninput={(e) => {
								set('site', { name: e.currentTarget.value });
							}}
						/></Field
					>
					<Field label="Title" hint="Browser tab title."
						><input
							class="input"
							value={str(obj('site').title)}
							oninput={(e) => {
								set('site', { title: e.currentTarget.value });
							}}
						/></Field
					>
					<Field label="Description"
						><input
							class="input"
							value={str(obj('site').description)}
							oninput={(e) => {
								set('site', { description: e.currentTarget.value });
							}}
						/></Field
					>
					<Field label="Site URL"
						><input
							class="input font-mono"
							value={str(obj('site').url)}
							oninput={(e) => {
								set('site', { url: e.currentTarget.value });
							}}
						/></Field
					>
					<Field label="Logo URL"
						><input
							class="input font-mono"
							value={str(obj('site').logo_url)}
							oninput={(e) => {
								set('site', { logo_url: e.currentTarget.value });
							}}
						/></Field
					>
					<Field label="Accent" hint="Hex color.">
						<div class="flex gap-2">
							<input
								class="input flex-1 font-mono"
								value={str(obj('site').accent)}
								oninput={(e) => {
									set('site', { accent: e.currentTarget.value });
								}}
								placeholder="#10b981"
							/>
							{#if str(obj('site').accent)}<span
									class="size-9 shrink-0 rounded-lg border border-edge"
									style:background={str(obj('site').accent)}
								></span>{/if}
						</div>
					</Field>
				</div>
				<div class="mt-3 grid gap-3 sm:grid-cols-[1fr_10rem]">
					<Field label="Announcement" hint="Banner shown on the status page. Empty hides it.">
						<input
							class="input"
							value={str(obj('site').announcement)}
							oninput={(e) => {
								set('site', { announcement: e.currentTarget.value });
							}}
						/>
					</Field>
					<Field label="Severity">
						<select
							class="input"
							value={str(obj('site').announcement_severity) || 'info'}
							onchange={(e) => {
								set('site', { announcement_severity: e.currentTarget.value });
							}}
						>
							<option value="info">info</option>
							<option value="warning">warning</option>
							<option value="critical">critical</option>
						</select>
					</Field>
				</div>
				<SaveBar
					dirty={dirty('site')}
					saving={secs.site.saving}
					onsave={() => save('site')}
					ondiscard={() => (secs.site.draft = structuredClone(secs.site.loaded))}
				/>
			</section>

			<!-- Page behavior -->
			<section id="sec-page" class="card scroll-mt-4 p-5">
				<div class="mb-4 flex items-center justify-between">
					<h2 class="text-sm font-semibold">Page</h2>
					<SectionChip section="page" overridden={secs.page.overridden} onreset={load} />
				</div>
				<div class="grid gap-3 sm:grid-cols-3">
					<Field label="Refresh (s)" hint="Client poll interval."
						><input
							class="input"
							type="number"
							min="5"
							value={num(obj('page').refresh_seconds)}
							oninput={(e) => {
								set('page', { refresh_seconds: Number(e.currentTarget.value) });
							}}
						/></Field
					>
					<Field label="History days" hint="Uptime bar length."
						><input
							class="input"
							type="number"
							min="7"
							max="365"
							value={num(obj('page').history_days)}
							oninput={(e) => {
								set('page', { history_days: Number(e.currentTarget.value) });
							}}
						/></Field
					>
					<Field label="Uptime legend">
						<select
							class="input"
							value={bool(obj('page').show_uptime_legend, true) ? 'on' : 'off'}
							onchange={(e) => {
								set('page', { show_uptime_legend: e.currentTarget.value === 'on' });
							}}
						>
							<option value="on">shown</option>
							<option value="off">hidden</option>
						</select>
					</Field>
				</div>
				<SaveBar
					dirty={dirty('page')}
					saving={secs.page.saving}
					onsave={() => save('page')}
					ondiscard={() => (secs.page.draft = structuredClone(secs.page.loaded))}
				/>
			</section>

			<!-- Monitor -->
			<section id="sec-monitor" class="card scroll-mt-4 p-5">
				<div class="mb-4 flex items-center justify-between">
					<h2 class="text-sm font-semibold">Monitor</h2>
					<SectionChip section="monitor" overridden={secs.monitor.overridden} onreset={load} />
				</div>
				<div class="grid gap-3 sm:grid-cols-3">
					<Field label="Concurrency"
						><input
							class="input"
							type="number"
							min="1"
							max="64"
							value={num(obj('monitor').concurrency)}
							oninput={(e) => {
								set('monitor', { concurrency: Number(e.currentTarget.value) });
							}}
						/></Field
					>
					<Field label="Interval (s)" hint="Default per-service interval."
						><input
							class="input"
							type="number"
							min="5"
							value={num(obj('monitor').default_interval_seconds)}
							oninput={(e) => {
								set('monitor', { default_interval_seconds: Number(e.currentTarget.value) });
							}}
						/></Field
					>
					<Field label="Timeout (ms)"
						><input
							class="input"
							type="number"
							min="250"
							value={num(obj('monitor').default_timeout_ms)}
							oninput={(e) => {
								set('monitor', { default_timeout_ms: Number(e.currentTarget.value) });
							}}
						/></Field
					>
					<Field label="Degraded (ms)"
						><input
							class="input"
							type="number"
							min="1"
							value={num(obj('monitor').default_degraded_ms)}
							oninput={(e) => {
								set('monitor', { default_degraded_ms: Number(e.currentTarget.value) });
							}}
						/></Field
					>
					<Field label="Fail threshold" hint="Failures before down."
						><input
							class="input"
							type="number"
							min="1"
							max="10"
							value={num(obj('monitor').failure_threshold)}
							oninput={(e) => {
								set('monitor', { failure_threshold: Number(e.currentTarget.value) });
							}}
						/></Field
					>
					<Field label="Recover threshold" hint="Successes before up."
						><input
							class="input"
							type="number"
							min="1"
							max="10"
							value={num(obj('monitor').recovery_threshold)}
							oninput={(e) => {
								set('monitor', { recovery_threshold: Number(e.currentTarget.value) });
							}}
						/></Field
					>
					<Field label="Retention days"
						><input
							class="input"
							type="number"
							min="1"
							value={num(obj('monitor').retention_days)}
							oninput={(e) => {
								set('monitor', { retention_days: Number(e.currentTarget.value) });
							}}
						/></Field
					>
					<Field label="Cert warn days"
						><input
							class="input"
							type="number"
							min="1"
							value={num(obj('monitor').cert_warn_days)}
							oninput={(e) => {
								set('monitor', { cert_warn_days: Number(e.currentTarget.value) });
							}}
						/></Field
					>
					<Field label="User agent"
						><input
							class="input font-mono"
							value={str(obj('monitor').user_agent)}
							oninput={(e) => {
								set('monitor', { user_agent: e.currentTarget.value });
							}}
						/></Field
					>
				</div>
				<SaveBar
					dirty={dirty('monitor')}
					saving={secs.monitor.saving}
					onsave={() => save('monitor')}
					ondiscard={() => (secs.monitor.draft = structuredClone(secs.monitor.loaded))}
				/>
			</section>

			<!-- Links -->
			<section id="sec-links" class="card scroll-mt-4 p-5">
				<div class="mb-4 flex items-center justify-between">
					<h2 class="flex items-center gap-2 text-sm font-semibold">
						Links
						<button class="btn btn-ghost btn-sm" title="Add link" onclick={addLink}
							><Plus class="size-3.5" /></button
						>
					</h2>
					<SectionChip section="links" overridden={secs.links.overridden} onreset={load} />
				</div>
				{#if links().length === 0}
					<p class="flex items-center gap-2 text-sm text-faint">
						<Link2 class="size-4" /> No footer links.
					</p>
				{:else}
					<div class="space-y-2">
						{#each links() as l, i (i)}
							<div class="flex items-center gap-2">
								<input
									class="input w-40"
									placeholder="Label"
									value={l.label}
									oninput={(e) => {
										setLink(i, { label: e.currentTarget.value });
									}}
								/>
								<input
									class="input flex-1 font-mono text-xs"
									placeholder="https://"
									value={l.href}
									oninput={(e) => {
										setLink(i, { href: e.currentTarget.value });
									}}
								/>
								<button
									class="btn btn-ghost btn-sm text-down-fg"
									title="Remove"
									onclick={() => {
										removeLink(i);
									}}><Trash class="size-3.5" /></button
								>
							</div>
						{/each}
					</div>
				{/if}
				<SaveBar
					dirty={dirty('links')}
					saving={secs.links.saving}
					onsave={() => save('links')}
					ondiscard={() => (secs.links.draft = structuredClone(secs.links.loaded))}
				/>
			</section>

			<!-- Admin policy -->
			<section id="sec-admin" class="card scroll-mt-4 p-5">
				<div class="mb-4 flex items-center justify-between">
					<h2 class="text-sm font-semibold">Panel policy</h2>
					<SectionChip section="admin" overridden={secs.admin.overridden} onreset={load} />
				</div>
				<div class="grid gap-3 sm:grid-cols-3">
					<Field
						label="Panel enabled"
						hint="Cannot be disabled from here; use wharfinger.toml or WHARFINGER_ADMIN_ENABLED=false."
					>
						<select
							class="input"
							value={bool(obj('admin').enabled, true) ? 'on' : 'off'}
							onchange={(e) => {
								set('admin', { enabled: e.currentTarget.value === 'on' });
							}}
						>
							<option value="on">enabled</option>
							<option value="off">disabled</option>
						</select>
					</Field>
					<Field label="Base path" hint="Changes the panel URL; the old path stops working.">
						<input
							class="input font-mono"
							value={str(obj('admin').base_path) || '/admin'}
							oninput={(e) => {
								set('admin', { base_path: e.currentTarget.value });
							}}
						/>
					</Field>
					<Field label="Session TTL (h)"
						><input
							class="input"
							type="number"
							min="1"
							max="720"
							value={num(obj('admin').session_ttl_hours)}
							oninput={(e) => {
								set('admin', { session_ttl_hours: Number(e.currentTarget.value) });
							}}
						/></Field
					>
					<Field label="Invite TTL (h)"
						><input
							class="input"
							type="number"
							min="1"
							max="720"
							value={num(obj('admin').invite_ttl_hours)}
							oninput={(e) => {
								set('admin', { invite_ttl_hours: Number(e.currentTarget.value) });
							}}
						/></Field
					>
					<Field label="Min password length"
						><input
							class="input"
							type="number"
							min="8"
							max="128"
							value={num(obj('admin').password_min_length)}
							oninput={(e) => {
								set('admin', { password_min_length: Number(e.currentTarget.value) });
							}}
						/></Field
					>
					<Field label="Login attempts" hint="Failures before lockout."
						><input
							class="input"
							type="number"
							min="2"
							max="50"
							value={num(obj('admin').login_max_attempts)}
							oninput={(e) => {
								set('admin', { login_max_attempts: Number(e.currentTarget.value) });
							}}
						/></Field
					>
					<Field label="Lockout (min)"
						><input
							class="input"
							type="number"
							min="1"
							max="1440"
							value={num(obj('admin').login_lockout_minutes)}
							oninput={(e) => {
								set('admin', { login_lockout_minutes: Number(e.currentTarget.value) });
							}}
						/></Field
					>
					<Field label="Setup page" hint="First-run account creation.">
						<select
							class="input"
							value={bool(obj('admin').allow_setup, true) ? 'on' : 'off'}
							onchange={(e) => {
								set('admin', { allow_setup: e.currentTarget.value === 'on' });
							}}
						>
							<option value="on">allowed</option>
							<option value="off">invite only</option>
						</select>
					</Field>
				</div>
				<SaveBar
					dirty={dirty('admin')}
					saving={secs.admin.saving}
					onsave={() => save('admin')}
					ondiscard={() => (secs.admin.draft = structuredClone(secs.admin.loaded))}
				/>
			</section>

			<!-- Telemetry -->
			<section id="sec-telemetry" class="card scroll-mt-4 p-5">
				<div class="mb-4 flex items-center justify-between">
					<h2 class="text-sm font-semibold">Telemetry</h2>
					<SectionChip section="telemetry" overridden={secs.telemetry.overridden} onreset={load} />
				</div>
				<div class="grid gap-3 sm:grid-cols-3">
					<Field label="Enabled" hint="Sentry protocol; works with Sentry, GlitchTip, and Bugsink.">
						<select
							class="input"
							value={bool(obj('telemetry').enabled, true) ? 'on' : 'off'}
							onchange={(e) => {
								set('telemetry', { enabled: e.currentTarget.value === 'on' });
							}}
						>
							<option value="on">enabled</option>
							<option value="off">disabled</option>
						</select>
					</Field>
					<Field label="DSN" hint="Empty disables delivery.">
						<input
							class="input font-mono"
							value={str(obj('telemetry').dsn)}
							oninput={(e) => {
								set('telemetry', { dsn: e.currentTarget.value });
							}}
							placeholder="https://key@host/1"
						/>
					</Field>
					<Field label="Environment">
						<input
							class="input"
							value={str(obj('telemetry').environment)}
							oninput={(e) => {
								set('telemetry', { environment: e.currentTarget.value });
							}}
							placeholder="production"
						/>
					</Field>
					<Field label="Client reports" hint="Forward browser crashes via /api/telemetry.">
						<select
							class="input"
							value={bool(obj('telemetry').client_reports, true) ? 'on' : 'off'}
							onchange={(e) => {
								set('telemetry', { client_reports: e.currentTarget.value === 'on' });
							}}
						>
							<option value="on">enabled</option>
							<option value="off">disabled</option>
						</select>
					</Field>
					<Field label="Max per minute" hint="Event cap; duplicates always collapse.">
						<input
							class="input"
							type="number"
							min="1"
							max="1000"
							value={num(obj('telemetry').max_per_minute)}
							oninput={(e) => {
								set('telemetry', { max_per_minute: Number(e.currentTarget.value) });
							}}
						/>
					</Field>
					<Field label="Connectivity" hint="Sends a test event to the current dsn.">
						<button
							class="btn"
							disabled={testing}
							onclick={() => {
								void sendTest();
							}}>{testing ? 'Sending...' : 'Send test event'}</button
						>
					</Field>
				</div>
				<SaveBar
					dirty={dirty('telemetry')}
					saving={secs.telemetry.saving}
					onsave={() => save('telemetry')}
					ondiscard={() => (secs.telemetry.draft = structuredClone(secs.telemetry.loaded))}
				/>
			</section>

			<!-- Raw TOML -->
			<section id="sec-toml" class="card scroll-mt-4 p-5">
				<h2 class="mb-1 text-sm font-semibold">Raw config</h2>
				<p class="mb-4 text-xs text-faint">
					Effective document as TOML. Saving diffs each section against the file and stores
					overrides only for what changed
					{#if tomlOverrides.length > 0}
						· overridden: <span class="font-mono">{tomlOverrides.join(', ')}</span>
					{/if}
				</p>
				<textarea
					class="input h-72 w-full font-mono text-xs leading-5"
					bind:value={toml}
					spellcheck="false"></textarea>
				<SaveBar
					dirty={tomlDirty}
					saving={tomlSaving}
					onsave={saveToml}
					ondiscard={() => (toml = tomlLoaded)}
				/>
			</section>

			<!-- Backup -->
			<section id="sec-backup" class="card scroll-mt-4 p-5">
				<h2 class="mb-1 text-sm font-semibold">Backup</h2>
				<p class="mb-4 text-xs text-faint">
					Export every config section as JSON, or restore from a file. Merge adds imported services
					by id; replace overwrites whole sections. Auth sections (admin, oidc, ldap) are never
					imported.
				</p>
				<div class="mb-3 grid gap-3 sm:grid-cols-2">
					<Field label="Export passphrase" hint="Seals the file; required again on restore.">
						<input
							class="input"
							type="password"
							bind:value={exportPassphrase}
							autocomplete="off"
							placeholder="empty exports plaintext"
						/>
					</Field>
					<Field label="Import passphrase" hint="Required only when the file is encrypted.">
						<input class="input" type="password" bind:value={importPassphrase} autocomplete="off" />
					</Field>
				</div>
				{#if !exportPassphrase}
					<p class="mb-3 text-xs text-degraded-fg">
						Plaintext export can contain literal credentials; set a passphrase to encrypt the file.
					</p>
				{/if}
				<div class="flex flex-wrap items-center gap-2">
					<button
						class="btn"
						disabled={backupBusy}
						onclick={() => {
							void exportBackup();
						}}
					>
						<Download class="size-3.5" /> Export JSON
					</button>
					<label class="btn cursor-pointer {backupBusy ? 'pointer-events-none opacity-50' : ''}">
						<Upload class="size-3.5" /> Import file
						<input
							type="file"
							accept="application/json"
							class="hidden"
							onchange={(e) => {
								void importBackup(e.currentTarget.files?.[0]);
							}}
						/>
					</label>
					<label class="flex items-center gap-1.5 text-xs text-muted">
						<input type="checkbox" bind:checked={backupMerge} /> merge services instead of replace
					</label>
				</div>
				{#if backupResult}
					<pre
						class="mt-3 max-h-40 overflow-auto rounded-lg bg-overlay/5 p-3 font-mono text-[11px] text-muted">{backupResult}</pre>
				{/if}
			</section>
		</div>
	</div>
{/if}
