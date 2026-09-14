<script lang="ts">
	import Field from './Field.svelte';
	import Modal from './Modal.svelte';
	import ServicePicker from './ServicePicker.svelte';
	import { NOTIFY_EVENTS } from '$lib/shared/notify';
	import type { TargetDraft } from '$lib/shared/drafts';

	let {
		open = $bindable(false),
		target,
		existingNames,
		services,
		onsave
	}: {
		open?: boolean;
		target: TargetDraft | null;
		existingNames: string[];
		services: { id: string; name: string }[];
		onsave: (draft: TargetDraft) => void;
	} = $props();

	let name = $state('');
	let type = $state<TargetDraft['type']>('ntfy');
	let url = $state('');
	let token = $state('');
	let botToken = $state('');
	let chatId = $state('');
	let user = $state('');
	let priority = $state('default');
	let tags = $state('');
	let clickUrl = $state('');
	let headers = $state('');
	let events = $state<string[]>([...NOTIFY_EVENTS]);
	let selected = $state<string[]>(['all']);
	let enabled = $state(true);
	let error = $state<string | null>(null);

	$effect(() => {
		if (open) {
			name = target?.name ?? '';
			type = target?.type ?? 'ntfy';
			url = target?.url ?? '';
			token = target?.token ?? '';
			botToken = target?.bot_token ?? '';
			chatId = target?.chat_id ?? '';
			user = target?.user ?? '';
			priority = target?.priority ?? 'default';
			tags = (target?.tags ?? []).join(', ');
			clickUrl = target?.click_url ?? '';
			headers = target?.headers
				? Object.entries(target.headers)
						.map(([k, v]) => `${k}=${v}`)
						.join('\n')
				: '';
			events = target?.events ? [...target.events] : [...NOTIFY_EVENTS];
			selected = target?.services ? [...target.services] : ['all'];
			enabled = target?.enabled ?? true;
			error = null;
		}
	});

	const isNew = $derived(target === null);

	function toggleEvent(e: string): void {
		events = events.includes(e) ? events.filter((x) => x !== e) : [...events, e];
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

	const URL_HINT: Record<TargetDraft['type'], string> = {
		ntfy: 'Full topic URL, e.g. https://ntfy.example.com/alerts',
		unifiedpush: 'The push endpoint URL from your distributor app',
		webhook: 'Endpoint that accepts a JSON POST',
		slack: 'Incoming webhook URL, e.g. https://hooks.slack.com/services/...',
		discord: 'Incoming webhook URL from the channel integrations settings',
		teams: 'Incoming webhook or Power Automate URL',
		telegram: 'Unused: messages go to api.telegram.org',
		gotify: 'Base URL of the Gotify server, e.g. https://gotify.example.com',
		pushover: 'Unused: messages go to api.pushover.net'
	};

	const NEEDS_URL = new Set<TargetDraft['type']>([
		'ntfy',
		'unifiedpush',
		'webhook',
		'slack',
		'discord',
		'teams',
		'gotify'
	]);
	const USES_PRIORITY = new Set<TargetDraft['type']>(['ntfy', 'gotify', 'pushover']);
	const TOKEN_FIELD: Partial<
		Record<TargetDraft['type'], { label: string; hint: string; required?: boolean }>
	> = {
		ntfy: {
			label: 'Token',
			hint: 'tk_... bearer token, or user:pass for basic auth. ${VAR} refs work.'
		},
		webhook: {
			label: 'Authorization header',
			hint: 'Sent verbatim as the Authorization header. ${VAR} refs work.'
		},
		gotify: {
			label: 'App token',
			hint: 'Gotify application token. ${VAR} refs work.',
			required: true
		},
		pushover: {
			label: 'API token',
			hint: 'Pushover application/api token. ${VAR} refs work.',
			required: true
		}
	};

	function submit(): void {
		error = null;
		if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
			error = 'name must be a lowercase slug';
			return;
		}
		if (isNew && existingNames.includes(name)) {
			error = 'that name is already in use';
			return;
		}
		if (NEEDS_URL.has(type) && !/^https?:\/\/.+/.test(url.trim())) {
			error = 'url must start with http:// or https://';
			return;
		}
		if (type === 'telegram' && (!botToken.trim() || !chatId.trim())) {
			error = 'telegram needs a bot token and a chat id';
			return;
		}
		if (TOKEN_FIELD[type]?.required && !token.trim()) {
			error = `${TOKEN_FIELD[type]?.label} is required for ${type}`;
			return;
		}
		if (type === 'pushover' && !user.trim()) {
			error = 'pushover needs a user or group key';
			return;
		}
		if (events.length === 0) {
			error = 'select at least one event';
			return;
		}
		if (selected.length === 0) {
			error = 'select at least one service';
			return;
		}
		const out: TargetDraft = {
			name: name.trim(),
			type,
			events,
			services: selected,
			enabled
		};
		if (NEEDS_URL.has(type)) out.url = url.trim();
		if (token.trim() && TOKEN_FIELD[type]) out.token = token.trim();
		if (type === 'telegram') {
			out.bot_token = botToken.trim();
			out.chat_id = chatId.trim();
		}
		if (type === 'pushover') out.user = user.trim();
		if (USES_PRIORITY.has(type) && priority !== 'default') out.priority = priority;
		const tagList = tags
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean);
		if (tagList.length > 0) out.tags = tagList;
		if (clickUrl.trim()) out.click_url = clickUrl.trim();
		const h = parseHeaders(headers);
		if (h) out.headers = h;
		onsave(out);
		open = false;
	}
</script>

<Modal bind:open title={isNew ? 'Add target' : `Edit ${target?.name ?? 'target'}`} wide>
	<form
		class="space-y-4"
		onsubmit={(e) => {
			e.preventDefault();
			submit();
		}}
	>
		<div class="grid grid-cols-2 gap-3">
			<Field
				label="Name"
				required
				hint={isNew ? 'Lowercase slug for logs.' : 'Names cannot change.'}
			>
				<input class="input font-mono" bind:value={name} disabled={!isNew} required />
			</Field>
			<Field label="Type" required>
				<select class="input" bind:value={type}>
					<option value="ntfy">ntfy</option>
					<option value="unifiedpush">UnifiedPush</option>
					<option value="webhook">Webhook (JSON)</option>
					<option value="slack">Slack</option>
					<option value="discord">Discord</option>
					<option value="teams">Teams</option>
					<option value="telegram">Telegram</option>
					<option value="gotify">Gotify</option>
					<option value="pushover">Pushover</option>
				</select>
			</Field>
		</div>
		{#if NEEDS_URL.has(type)}
			<Field label="Endpoint URL" required hint={URL_HINT[type]}>
				<input class="input font-mono" bind:value={url} placeholder="https://" required />
			</Field>
		{/if}

		{#if TOKEN_FIELD[type]}
			<Field
				label={TOKEN_FIELD[type]?.label ?? 'Token'}
				required={TOKEN_FIELD[type]?.required}
				hint={TOKEN_FIELD[type]?.hint}
			>
				<input class="input font-mono" bind:value={token} placeholder="${'${TOKEN}'}" />
			</Field>
		{/if}

		{#if type === 'telegram'}
			<div class="grid grid-cols-2 gap-3">
				<Field label="Bot token" required hint={'From @BotFather. ${VAR} refs work.'}>
					<input
						class="input font-mono"
						bind:value={botToken}
						placeholder="${'${TG_BOT_TOKEN}'}"
						required
					/>
				</Field>
				<Field label="Chat ID" required hint="Target chat or channel id.">
					<input class="input font-mono" bind:value={chatId} required />
				</Field>
			</div>
		{/if}

		{#if type === 'pushover'}
			<Field label="User key" required hint={'Pushover user or group key. ${VAR} refs work.'}>
				<input
					class="input font-mono"
					bind:value={user}
					placeholder="${'${PUSHOVER_USER}'}"
					required
				/>
			</Field>
		{/if}

		{#if USES_PRIORITY.has(type)}
			<div class="grid {type === 'ntfy' ? 'grid-cols-2' : ''} gap-3">
				<Field
					label="Priority"
					hint={type === 'gotify'
						? 'Mapped to the Gotify 0-10 scale.'
						: type === 'pushover'
							? 'Mapped to -2..2; urgent sends an emergency priority.'
							: undefined}
				>
					<select class="input" bind:value={priority}>
						{#each ['min', 'low', 'default', 'high', 'urgent'] as p (p)}
							<option value={p}>{p}</option>
						{/each}
					</select>
				</Field>
				{#if type === 'ntfy'}
					<Field label="Tags" hint="Comma separated ntfy emoji tags.">
						<input class="input" bind:value={tags} placeholder="warning, rotating_light" />
					</Field>
				{/if}
			</div>
		{/if}

		{#if type === 'ntfy'}
			<Field label="Click URL" hint="Where the notification links; defaults to the site URL.">
				<input class="input font-mono" bind:value={clickUrl} />
			</Field>
		{/if}

		{#if type === 'webhook'}
			<Field label="Extra headers" hint="One per line: Name=value.">
				<textarea class="input h-16" bind:value={headers}></textarea>
			</Field>
		{/if}

		<Field label="Events" required>
			<div class="flex flex-wrap gap-1.5">
				{#each NOTIFY_EVENTS as e (e)}
					<button
						type="button"
						class="chip {events.includes(e) ? 'chip-on' : ''} cursor-pointer py-1"
						onclick={() => {
							toggleEvent(e);
						}}>{e}</button
					>
				{/each}
			</div>
		</Field>
		<Field label="Services" required>
			<ServicePicker {services} bind:selected />
		</Field>
		<label class="flex items-center gap-2 text-sm text-muted">
			<input type="checkbox" bind:checked={enabled} /> Enabled
		</label>

		{#if error}<p class="text-sm text-down-fg" role="alert">{error}</p>{/if}
		<div class="flex justify-end gap-2 pt-1">
			<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
			<button type="submit" class="btn btn-primary">{isNew ? 'Add target' : 'Save'}</button>
		</div>
	</form>
</Modal>
