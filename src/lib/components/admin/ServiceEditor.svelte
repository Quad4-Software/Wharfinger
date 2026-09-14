<script lang="ts">
	import Field from './Field.svelte';
	import Modal from './Modal.svelte';
	import type { ServiceDraft } from '$lib/shared/drafts';

	let {
		open = $bindable(false),
		service,
		existingIds,
		onsave
	}: {
		open?: boolean;
		service: ServiceDraft | null;
		existingIds: string[];
		onsave: (draft: ServiceDraft) => void;
	} = $props();

	let draft = $state<ServiceDraft>(blank());
	let error = $state<string | null>(null);

	function blank(): ServiceDraft {
		return { id: '', name: '', group: 'General', type: 'http', url: 'https://' };
	}

	$effect(() => {
		if (open) {
			draft = service ? { ...service } : blank();
			error = null;
		}
	});

	const isNew = $derived(service === null);
	const idTaken = $derived(isNew && existingIds.includes(draft.id));

	function str(v: unknown): string {
		return typeof v === 'string' ? v : '';
	}
	function num(v: unknown): number | undefined {
		return typeof v === 'number' ? v : undefined;
	}
	function bool(v: unknown, dflt: boolean): boolean {
		return typeof v === 'boolean' ? v : dflt;
	}
	function csv(v: unknown): string {
		return Array.isArray(v) ? v.join(', ') : '';
	}

	function parseCsv(v: string): string[] {
		return v
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	}

	function parseHeaders(v: string): Record<string, string> | undefined {
		const out: Record<string, string> = {};
		for (const line of v.split('\n')) {
			const i = line.indexOf('=');
			if (i <= 0) continue;
			out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
		}
		return Object.keys(out).length > 0 ? out : undefined;
	}

	function headersText(v: unknown): string {
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			return Object.entries(v as Record<string, string>)
				.map(([k, val]) => `${k}=${val}`)
				.join('\n');
		}
		return '';
	}

	function submit(): void {
		error = null;
		if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(draft.id)) {
			error = 'id must be a lowercase slug (a-z, 0-9, _-)';
			return;
		}
		if (idTaken) {
			error = 'that id is already in use';
			return;
		}
		if (!draft.name.trim()) {
			error = 'name is required';
			return;
		}
		const out: ServiceDraft = {
			id: draft.id.trim(),
			name: draft.name.trim(),
			group: draft.group.trim() || 'General',
			type: draft.type
		};
		if (draft.description?.trim()) out.description = draft.description.trim();

		const put = (
			key: string,
			v: unknown,
			keep: (x: unknown) => boolean = (x) => x !== undefined
		) => {
			if (keep(v)) out[key] = v;
		};
		const optNum = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));

		if (draft.type === 'http') {
			out.url = str(draft.url).trim();
			if (!/^https?:\/\/.+/.test(out.url as string)) {
				error = 'url must start with http:// or https://';
				return;
			}
			put('method', draft.method === 'HEAD' ? 'HEAD' : undefined);
			const statuses = parseCsv(str(draft._statuses ?? csv(draft.expected_statuses)))
				.map(Number)
				.filter((n) => n >= 100 && n <= 599);
			put('expected_statuses', statuses.length > 0 ? statuses : undefined);
			put('keyword', str(draft.keyword).trim() || undefined);
			if (draft.keyword_absent === true) out.keyword_absent = true;
			put('headers', parseHeaders(str(draft._headers ?? headersText(draft.headers))));
			if (draft.follow_redirects === false) out.follow_redirects = false;
			if (draft.cert_check === false) out.cert_check = false;
			put('cert_warn_days', num(draft.cert_warn_days));
		} else if (draft.type === 'tcp') {
			out.host = str(draft.host).trim();
			out.port = num(draft.port);
			if (!out.host || !out.port) {
				error = 'host and port are required';
				return;
			}
			if (draft.tls === true) out.tls = true;
			put('cert_warn_days', num(draft.cert_warn_days));
		} else if (draft.type === 'json') {
			out.url = str(draft.url).trim();
			if (!/^https?:\/\/.+/.test(out.url as string)) {
				error = 'url must start with http:// or https://';
				return;
			}
			out.json_path = str(draft.json_path).trim();
			if (!out.json_path) {
				error = 'json path is required (e.g. status or data.healthy)';
				return;
			}
			put('json_value', str(draft.json_value).trim() || undefined);
			const statuses = parseCsv(str(draft._statuses ?? csv(draft.expected_statuses)))
				.map(Number)
				.filter((n) => n >= 100 && n <= 599);
			put('expected_statuses', statuses.length > 0 ? statuses : undefined);
			put('headers', parseHeaders(str(draft._headers ?? headersText(draft.headers))));
		} else if (draft.type === 'a2s') {
			out.host = str(draft.host).trim();
			out.port = num(draft.port);
			if (!out.host || !out.port) {
				error = 'host and query port are required';
				return;
			}
		} else if (draft.type === 'postgres' || draft.type === 'mysql' || draft.type === 'redis') {
			out.host = str(draft.host).trim();
			if (!out.host) {
				error = 'host is required';
				return;
			}
			put('port', num(draft.port));
			if (draft.type === 'postgres') {
				put('user', str(draft.user).trim() || undefined);
				put('database', str(draft.database).trim() || undefined);
			}
		} else if (draft.type === 'rdap') {
			out.domain = str(draft.domain).trim();
			if (!out.domain) {
				error = 'domain is required';
				return;
			}
			put('warn_days', num(draft.warn_days));
		} else if (draft.type === 'domain') {
			out.domain = str(draft.domain).trim();
			if (!out.domain) {
				error = 'domain is required';
				return;
			}
			const ports = parseCsv(str(draft._ports ?? csv(draft.ports)))
				.map(Number)
				.filter((n) => n >= 1 && n <= 65535);
			put('ports', ports.length > 0 ? ports : undefined);
			const expected = parseCsv(str(draft._expected ?? csv(draft.expected_open)))
				.map(Number)
				.filter((n) => n >= 1 && n <= 65535);
			put('expected_open', expected.length > 0 ? expected : undefined);
			if (draft.tls === false) out.tls = false;
			if (draft.headers === false) out.headers = false;
			if (draft.dane === false) out.dane = false;
			put('cert_warn_days', num(draft.cert_warn_days));
		} else if (draft.type === 'xmpp' || draft.type === 'irc') {
			out.host = str(draft.host).trim();
			if (!out.host) {
				error = 'host is required';
				return;
			}
			put('port', num(draft.port));
			if (draft.type === 'xmpp') {
				put('domain', str(draft.domain).trim() || undefined);
				if (draft.tls === true) out.tls = true;
			} else {
				put('nick', str(draft.nick).trim() || undefined);
				if (draft.tls === false) out.tls = false;
			}
			put('cert_warn_days', num(draft.cert_warn_days));
		} else if (draft.type === 'websocket') {
			out.url = str(draft.url).trim();
			if (!/^wss?:\/\/.+/.test(out.url as string)) {
				error = 'url must start with ws:// or wss://';
				return;
			}
		} else if (draft.type === 'push') {
			put('expected_interval_seconds', num(draft.expected_interval_seconds));
			put('grace_seconds', num(draft.grace_seconds));
		} else if (draft.type === 'ping') {
			out.host = str(draft.host).trim();
			if (!out.host) {
				error = 'host is required';
				return;
			}
			const ports = parseCsv(str(draft._ports ?? csv(draft.ports)))
				.map(Number)
				.filter((n) => n >= 1 && n <= 65535);
			put('ports', ports.length > 0 ? ports : undefined);
		} else {
			out.host = str(draft.host).trim();
			if (!out.host) {
				error = 'host is required';
				return;
			}
			if (draft.record_type && draft.record_type !== 'A') out.record_type = draft.record_type;
		}

		put(
			'interval_seconds',
			optNum(str(draft._interval ?? num(draft.interval_seconds)?.toString() ?? ''))
		);
		put('timeout_ms', optNum(str(draft._timeout ?? num(draft.timeout_ms)?.toString() ?? '')));
		put('degraded_ms', optNum(str(draft._degraded ?? num(draft.degraded_ms)?.toString() ?? '')));
		onsave(out);
		open = false;
	}
</script>

<Modal bind:open title={isNew ? 'Add service' : `Edit ${service?.name ?? 'service'}`} wide>
	<form
		class="space-y-4"
		onsubmit={(e) => {
			e.preventDefault();
			submit();
		}}
	>
		<div class="grid grid-cols-2 gap-3">
			<Field
				label="ID"
				required
				hint={isNew
					? 'Stable lowercase slug used in URLs and checks.'
					: 'Ids cannot change after creation.'}
			>
				<input class="input font-mono" bind:value={draft.id} disabled={!isNew} required />
			</Field>
			<Field label="Name" required>
				<input class="input" bind:value={draft.name} required />
			</Field>
		</div>
		<div class="grid grid-cols-2 gap-3">
			<Field label="Group">
				<input class="input" bind:value={draft.group} placeholder="General" />
			</Field>
			<Field label="Check type" required>
				<select class="input" bind:value={draft.type}>
					<option value="http">HTTP(S)</option>
					<option value="json">JSON API</option>
					<option value="tcp">TCP (+TLS)</option>
					<option value="dns">DNS</option>
					<option value="a2s">Game server (A2S)</option>
					<option value="postgres">PostgreSQL</option>
					<option value="mysql">MySQL</option>
					<option value="redis">Redis</option>
					<option value="websocket">WebSocket</option>
					<option value="rdap">Domain expiry (RDAP)</option>
					<option value="domain">Domain health</option>
					<option value="xmpp">XMPP</option>
					<option value="irc">IRC</option>
					<option value="push">Push (cron / heartbeat)</option>
					<option value="ping">Ping (TCP ports)</option>
				</select>
			</Field>
		</div>
		<Field label="Description">
			<input
				class="input"
				value={str(draft.description)}
				oninput={(e) => (draft.description = e.currentTarget.value)}
			/>
		</Field>

		{#if draft.type === 'http'}
			<Field label="URL" required>
				<input
					class="input font-mono"
					value={str(draft.url)}
					oninput={(e) => (draft.url = e.currentTarget.value)}
					placeholder="https://example.com/health"
					required
				/>
			</Field>
			<div class="grid grid-cols-2 gap-3">
				<Field label="Method">
					<select
						class="input"
						value={str(draft.method)}
						onchange={(e) => (draft.method = e.currentTarget.value)}
					>
						<option value="">GET</option>
						<option value="HEAD">HEAD</option>
					</select>
				</Field>
				<Field label="Expected statuses" hint="Comma separated, default 200.">
					<input
						class="input font-mono"
						value={csv(draft.expected_statuses)}
						oninput={(e) => (draft._statuses = e.currentTarget.value)}
						placeholder="200, 301"
					/>
				</Field>
			</div>
			<div class="grid grid-cols-2 gap-3">
				<Field label="Keyword" hint="Body must contain this text.">
					<input
						class="input font-mono"
						value={str(draft.keyword)}
						oninput={(e) => (draft.keyword = e.currentTarget.value)}
					/>
				</Field>
				<div class="flex flex-col justify-end gap-2 pb-1">
					<label class="flex items-center gap-2 text-sm text-muted">
						<input
							type="checkbox"
							checked={bool(draft.keyword_absent, false)}
							onchange={(e) => (draft.keyword_absent = e.currentTarget.checked)}
						/> Keyword must be absent
					</label>
					<label class="flex items-center gap-2 text-sm text-muted">
						<input
							type="checkbox"
							checked={bool(draft.follow_redirects, true)}
							onchange={(e) => (draft.follow_redirects = e.currentTarget.checked)}
						/> Follow redirects
					</label>
				</div>
			</div>
			<div class="grid grid-cols-2 gap-3">
				<div class="flex items-center gap-4 pt-6">
					<label class="flex items-center gap-2 text-sm text-muted">
						<input
							type="checkbox"
							checked={bool(draft.cert_check, true)}
							onchange={(e) => (draft.cert_check = e.currentTarget.checked)}
						/> Check TLS cert
					</label>
				</div>
				<Field label="Cert warn days" hint="Alert when expiry is near.">
					<input
						class="input"
						type="number"
						min="1"
						value={num(draft.cert_warn_days) ?? ''}
						oninput={(e) => (draft.cert_warn_days = Number(e.currentTarget.value))}
					/>
				</Field>
			</div>
			<Field label="Extra headers" hint={'One per line: Name=${VAR} or Name=value'}>
				<textarea
					class="input h-20"
					value={headersText(draft.headers)}
					oninput={(e) => (draft._headers = e.currentTarget.value)}
					placeholder={'Authorization=${API_TOKEN}'}></textarea>
			</Field>
		{:else if draft.type === 'tcp'}
			<div class="grid grid-cols-3 gap-3">
				<div class="col-span-2">
					<Field label="Host" required>
						<input
							class="input font-mono"
							value={str(draft.host)}
							oninput={(e) => (draft.host = e.currentTarget.value)}
							required
						/>
					</Field>
				</div>
				<Field label="Port" required>
					<input
						class="input"
						type="number"
						min="1"
						max="65535"
						value={num(draft.port) ?? ''}
						oninput={(e) => (draft.port = Number(e.currentTarget.value))}
						required
					/>
				</Field>
			</div>
			<div class="grid grid-cols-2 gap-3">
				<label class="flex items-center gap-2 pt-6 text-sm text-muted">
					<input
						type="checkbox"
						checked={bool(draft.tls, false)}
						onchange={(e) => (draft.tls = e.currentTarget.checked)}
					/> TLS handshake + cert watch
				</label>
				<Field label="Cert warn days">
					<input
						class="input"
						type="number"
						min="1"
						value={num(draft.cert_warn_days) ?? ''}
						oninput={(e) => (draft.cert_warn_days = Number(e.currentTarget.value))}
					/>
				</Field>
			</div>
		{:else if draft.type === 'json'}
			<Field label="URL" required>
				<input
					class="input font-mono"
					value={str(draft.url)}
					oninput={(e) => (draft.url = e.currentTarget.value)}
					placeholder="https://api.example.com/health"
					required
				/>
			</Field>
			<div class="grid grid-cols-2 gap-3">
				<Field label="JSON path" required hint="Dot path, e.g. data.healthy or items.0.ok">
					<input
						class="input font-mono"
						value={str(draft.json_path)}
						oninput={(e) => (draft.json_path = e.currentTarget.value)}
						placeholder="status"
						required
					/>
				</Field>
				<Field label="Expected value" hint="Empty: path must be truthy. Otherwise strict match.">
					<input
						class="input font-mono"
						value={str(draft.json_value)}
						oninput={(e) => (draft.json_value = e.currentTarget.value)}
						placeholder="ok"
					/>
				</Field>
			</div>
			<Field label="Expected statuses" hint="Comma separated, default 200.">
				<input
					class="input font-mono"
					value={csv(draft.expected_statuses)}
					oninput={(e) => (draft._statuses = e.currentTarget.value)}
					placeholder="200"
				/>
			</Field>
			<Field label="Extra headers" hint={'One per line: Name=${VAR} or Name=value'}>
				<textarea
					class="input h-20"
					value={headersText(draft.headers)}
					oninput={(e) => (draft._headers = e.currentTarget.value)}
					placeholder={'Authorization=${API_TOKEN}'}></textarea>
			</Field>
		{:else if draft.type === 'a2s'}
			<div class="grid grid-cols-3 gap-3">
				<div class="col-span-2">
					<Field label="Host" required hint="Source-engine game server (CS2, Rust, ARK, ...).">
						<input
							class="input font-mono"
							value={str(draft.host)}
							oninput={(e) => (draft.host = e.currentTarget.value)}
							required
						/>
					</Field>
				</div>
				<Field label="Query port" required hint="Usually game port +1 or 27015.">
					<input
						class="input"
						type="number"
						min="1"
						max="65535"
						value={num(draft.port) ?? ''}
						oninput={(e) => (draft.port = Number(e.currentTarget.value))}
						placeholder="27015"
						required
					/>
				</Field>
			</div>
		{:else if draft.type === 'postgres' || draft.type === 'mysql' || draft.type === 'redis'}
			<div class="grid grid-cols-3 gap-3">
				<div class="col-span-2">
					<Field label="Host" required>
						<input
							class="input font-mono"
							value={str(draft.host)}
							oninput={(e) => (draft.host = e.currentTarget.value)}
							required
						/>
					</Field>
				</div>
				<Field
					label="Port"
					hint={draft.type === 'postgres'
						? 'Default 5432.'
						: draft.type === 'mysql'
							? 'Default 3306.'
							: 'Default 6379.'}
				>
					<input
						class="input"
						type="number"
						min="1"
						max="65535"
						value={num(draft.port) ?? ''}
						oninput={(e) =>
							(draft.port =
								e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))}
						placeholder={draft.type === 'postgres'
							? '5432'
							: draft.type === 'mysql'
								? '3306'
								: '6379'}
					/>
				</Field>
			</div>
			{#if draft.type === 'postgres'}
				<div class="grid grid-cols-2 gap-3">
					<Field label="User" hint="StartupMessage only; no auth.">
						<input
							class="input font-mono"
							value={str(draft.user)}
							oninput={(e) => (draft.user = e.currentTarget.value)}
							placeholder="monitor"
						/>
					</Field>
					<Field label="Database" hint="Optional; sent in the StartupMessage.">
						<input
							class="input font-mono"
							value={str(draft.database)}
							oninput={(e) => (draft.database = e.currentTarget.value)}
						/>
					</Field>
				</div>
			{/if}
		{:else if draft.type === 'rdap'}
			<div class="grid grid-cols-2 gap-3">
				<Field label="Domain" required hint="RDAP lookup; monitors registration expiry.">
					<input
						class="input font-mono"
						value={str(draft.domain)}
						oninput={(e) => (draft.domain = e.currentTarget.value)}
						placeholder="example.com"
						required
					/>
				</Field>
				<Field label="Warn days" hint="Degraded inside this window. Default 14.">
					<input
						class="input"
						type="number"
						min="1"
						max="365"
						value={num(draft.warn_days) ?? ''}
						oninput={(e) =>
							(draft.warn_days =
								e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))}
						placeholder="14"
					/>
				</Field>
			</div>
		{:else if draft.type === 'domain'}
			<Field
				label="Domain"
				required
				hint="Composite health: DNS, :443 cert, headers, port sweep, DANE."
			>
				<input
					class="input font-mono"
					value={str(draft.domain)}
					oninput={(e) => (draft.domain = e.currentTarget.value)}
					placeholder="example.com"
					required
				/>
			</Field>
			<div class="grid grid-cols-2 gap-3">
				<Field label="Ports to probe" hint="Comma separated; blank uses the default list.">
					<input
						class="input font-mono"
						value={csv(draft.ports)}
						oninput={(e) => (draft._ports = e.currentTarget.value)}
						placeholder="22, 80, 443"
					/>
				</Field>
				<Field label="Expected open" hint="Optional drift list; open ports outside it degrade.">
					<input
						class="input font-mono"
						value={csv(draft.expected_open)}
						oninput={(e) => (draft._expected = e.currentTarget.value)}
						placeholder="80, 443"
					/>
				</Field>
			</div>
			<div class="grid grid-cols-2 gap-3">
				<div class="flex flex-col justify-center gap-2">
					<label class="flex items-center gap-2 text-sm text-muted">
						<input
							type="checkbox"
							checked={bool(draft.tls, true)}
							onchange={(e) => (draft.tls = e.currentTarget.checked)}
						/> TLS cert on :443
					</label>
					<label class="flex items-center gap-2 text-sm text-muted">
						<input
							type="checkbox"
							checked={bool(draft.headers, true)}
							onchange={(e) => (draft.headers = e.currentTarget.checked)}
						/> Security headers
					</label>
					<label class="flex items-center gap-2 text-sm text-muted">
						<input
							type="checkbox"
							checked={bool(draft.dane, true)}
							onchange={(e) => (draft.dane = e.currentTarget.checked)}
						/> DANE (TLSA) validation
					</label>
				</div>
				<Field label="Cert warn days" hint="Alert when expiry is near.">
					<input
						class="input"
						type="number"
						min="1"
						value={num(draft.cert_warn_days) ?? ''}
						oninput={(e) => (draft.cert_warn_days = Number(e.currentTarget.value))}
					/>
				</Field>
			</div>
		{:else if draft.type === 'xmpp'}
			<div class="grid grid-cols-3 gap-3">
				<div class="col-span-2">
					<Field label="Host" required hint="Client stream probe; waits for stream features.">
						<input
							class="input font-mono"
							value={str(draft.host)}
							oninput={(e) => (draft.host = e.currentTarget.value)}
							required
						/>
					</Field>
				</div>
				<Field label="Port" hint="Default 5222; 5223 for direct TLS.">
					<input
						class="input"
						type="number"
						min="1"
						max="65535"
						value={num(draft.port) ?? ''}
						oninput={(e) =>
							(draft.port =
								e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))}
						placeholder="5222"
					/>
				</Field>
			</div>
			<div class="grid grid-cols-2 gap-3">
				<Field label="XMPP domain" hint="Stream 'to' attribute; defaults to the host.">
					<input
						class="input font-mono"
						value={str(draft.domain)}
						oninput={(e) => (draft.domain = e.currentTarget.value)}
						placeholder="example.com"
					/>
				</Field>
				<Field label="Cert warn days" hint="Only with direct TLS.">
					<input
						class="input"
						type="number"
						min="1"
						value={num(draft.cert_warn_days) ?? ''}
						oninput={(e) =>
							(draft.cert_warn_days =
								e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))}
					/>
				</Field>
			</div>
			<label class="flex items-center gap-2 text-sm text-muted">
				<input
					type="checkbox"
					checked={bool(draft.tls, false)}
					onchange={(e) => (draft.tls = e.currentTarget.checked)}
				/> Direct TLS on connect (not STARTTLS)
			</label>
		{:else if draft.type === 'irc'}
			<div class="grid grid-cols-3 gap-3">
				<div class="col-span-2">
					<Field label="Host" required hint="Registers a nick; waits for the 001 welcome.">
						<input
							class="input font-mono"
							value={str(draft.host)}
							oninput={(e) => (draft.host = e.currentTarget.value)}
							required
						/>
					</Field>
				</div>
				<Field label="Port" hint="Default 6697 (TLS).">
					<input
						class="input"
						type="number"
						min="1"
						max="65535"
						value={num(draft.port) ?? ''}
						oninput={(e) =>
							(draft.port =
								e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))}
						placeholder="6697"
					/>
				</Field>
			</div>
			<div class="grid grid-cols-2 gap-3">
				<Field label="Nick" hint="Optional; a random statXXXXXX is used otherwise.">
					<input
						class="input font-mono"
						value={str(draft.nick)}
						oninput={(e) => (draft.nick = e.currentTarget.value)}
						placeholder="statusmon"
					/>
				</Field>
				<Field label="Cert warn days">
					<input
						class="input"
						type="number"
						min="1"
						value={num(draft.cert_warn_days) ?? ''}
						oninput={(e) =>
							(draft.cert_warn_days =
								e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))}
					/>
				</Field>
			</div>
			<label class="flex items-center gap-2 text-sm text-muted">
				<input
					type="checkbox"
					checked={bool(draft.tls, true)}
					onchange={(e) => (draft.tls = e.currentTarget.checked)}
				/> TLS connection + cert watch
			</label>
		{:else if draft.type === 'websocket'}
			<Field label="WebSocket URL" required hint="Upgrade handshake only; no frames are sent.">
				<input
					class="input font-mono"
					value={str(draft.url)}
					oninput={(e) => (draft.url = e.currentTarget.value)}
					placeholder="wss://example.com/socket"
					required
				/>
			</Field>
		{:else if draft.type === 'push'}
			<p class="text-xs text-faint">
				Dead man's switch: the job calls its unique check-in URL every interval; a missed beat past
				the grace window flips the service down. Save, then copy the URL from the service list.
			</p>
			<div class="grid grid-cols-2 gap-3">
				<Field label="Expected interval (s)" hint="How often the job checks in. Default 300.">
					<input
						class="input"
						type="number"
						min="10"
						value={num(draft.expected_interval_seconds) ?? ''}
						oninput={(e) =>
							(draft.expected_interval_seconds =
								e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))}
						placeholder="300"
					/>
				</Field>
				<Field label="Grace (s)" hint="Extra slack before a missed beat is down. Default 60.">
					<input
						class="input"
						type="number"
						min="0"
						value={num(draft.grace_seconds) ?? ''}
						oninput={(e) =>
							(draft.grace_seconds =
								e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))}
						placeholder="60"
					/>
				</Field>
			</div>
		{:else if draft.type === 'ping'}
			<Field label="Host or IP" required>
				<input
					class="input font-mono"
					value={str(draft.host)}
					oninput={(e) => (draft.host = e.currentTarget.value)}
					required
				/>
			</Field>
			<Field label="TCP ports" hint="Comma separated; up when any accepts. Default 443, 80, 22.">
				<input
					class="input font-mono"
					value={csv(draft.ports)}
					oninput={(e) => (draft._ports = e.currentTarget.value)}
					placeholder="443, 80, 22"
				/>
			</Field>
		{:else}
			<div class="grid grid-cols-3 gap-3">
				<div class="col-span-2">
					<Field label="Host" required>
						<input
							class="input font-mono"
							value={str(draft.host)}
							oninput={(e) => (draft.host = e.currentTarget.value)}
							required
						/>
					</Field>
				</div>
				<Field label="Record type">
					<select
						class="input"
						value={str(draft.record_type)}
						onchange={(e) => (draft.record_type = e.currentTarget.value)}
					>
						{#each ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'] as rt (rt)}
							<option value={rt}>{rt}</option>
						{/each}
					</select>
				</Field>
			</div>
		{/if}

		<details class="rounded-lg border border-edge p-3">
			<summary class="cursor-pointer text-sm text-muted">Timing overrides</summary>
			<div class="mt-3 grid grid-cols-3 gap-3">
				<Field label="Interval (s)">
					<input
						class="input"
						type="number"
						min="5"
						value={num(draft.interval_seconds) ?? ''}
						oninput={(e) => (draft._interval = e.currentTarget.value)}
					/>
				</Field>
				<Field label="Timeout (ms)">
					<input
						class="input"
						type="number"
						min="250"
						value={num(draft.timeout_ms) ?? ''}
						oninput={(e) => (draft._timeout = e.currentTarget.value)}
					/>
				</Field>
				<Field label="Degraded (ms)">
					<input
						class="input"
						type="number"
						min="1"
						value={num(draft.degraded_ms) ?? ''}
						oninput={(e) => (draft._degraded = e.currentTarget.value)}
					/>
				</Field>
			</div>
		</details>

		{#if error}<p class="text-sm text-down-fg" role="alert">{error}</p>{/if}
		<div class="flex justify-end gap-2 pt-1">
			<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
			<button type="submit" class="btn btn-primary">{isNew ? 'Add service' : 'Save'}</button>
		</div>
	</form>
</Modal>
