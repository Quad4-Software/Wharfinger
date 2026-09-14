import type { NotifyTargetConfig } from '$lib/server/config/schema';
import {
	blockedHost,
	EGRESS_BLOCKED_DETAIL,
	type Egress,
	type FetchInit
} from '$lib/server/http/egress';
import type { NotifyMessage } from './templates';

export interface SendResult {
	ok: boolean;
	status: number | null;
	error: string | null;
}

function ntfyAuth(token: string): string {
	// ntfy tokens start with tk_; anything else is treated as user:pass
	// basic auth credentials.
	return token.startsWith('tk_')
		? `Bearer ${token}`
		: `Basic ${Buffer.from(token).toString('base64')}`;
}

const NTFY_PRIORITY: Record<string, string> = {
	min: '1',
	low: '2',
	default: '3',
	high: '4',
	urgent: '5',
	'1': '1',
	'2': '2',
	'3': '3',
	'4': '4',
	'5': '5'
};

// Outbound message text is capped so a long detail line cannot blow
// up chat payloads or trigger provider-side length errors.
const MAX_TEXT = 4000;

function clip(s: string, max = MAX_TEXT): string {
	return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

// telegram sends with parse_mode=HTML; rendered text is escaped so a
// '<' in a service name cannot break markup.
function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Discord embed color / Teams themeColor by event kind.
const EVENT_COLOR: Record<string, number> = {
	down: 0xd64545,
	incident: 0xd64545,
	degraded: 0xd69a00,
	recovered: 0x2ea043,
	maintenance: 0x3b82f6,
	test: 0x3b82f6
};

// gotify priority is 0-10; the named levels map onto it.
const GOTIFY_PRIORITY: Record<string, number> = {
	min: 0,
	low: 2,
	default: 5,
	high: 8,
	urgent: 10,
	'1': 1,
	'2': 3,
	'3': 5,
	'4': 7,
	'5': 10
};

// pushover priority is -2..2; 2 (emergency) requires retry+expire,
// added by the sender when it applies.
const PUSHOVER_PRIORITY: Record<string, number> = {
	min: -2,
	low: -1,
	default: 0,
	high: 1,
	urgent: 2,
	'1': -1,
	'2': 0,
	'3': 0,
	'4': 1,
	'5': 2
};

async function post(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	egress: Egress
): Promise<SendResult> {
	try {
		const host = new URL(url).hostname;
		if (!egress.allowLinkLocal() && blockedHost(host)) {
			return { ok: false, status: null, error: EGRESS_BLOCKED_DETAIL };
		}
		const res = await fetch(url, {
			...init,
			signal: AbortSignal.timeout(timeoutMs),
			redirect: 'manual',
			dispatcher: egress.dispatcher
		} as FetchInit);
		// Drain so the connection can be reused; we never read the body.
		await res.arrayBuffer().catch(() => undefined);
		if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, error: null };
		return { ok: false, status: res.status, error: `HTTP ${res.status}` };
	} catch (err) {
		return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
	}
}

function jsonPost(
	url: string,
	body: unknown,
	timeoutMs: number,
	egress: Egress,
	headers: Record<string, string> = {}
): Promise<SendResult> {
	return post(
		url,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: JSON.stringify(body)
		},
		timeoutMs,
		egress
	);
}

export async function sendToTarget(
	target: NotifyTargetConfig,
	msg: NotifyMessage,
	timeoutMs: number,
	egress: Egress
): Promise<SendResult> {
	// telegram and pushover post to fixed endpoints; everything else
	// needs a configured url.
	if (target.type === 'telegram') {
		const text = clip(`<b>${esc(msg.title)}</b>\n${esc(msg.body)}`);
		return jsonPost(
			`https://api.telegram.org/bot${target.bot_token}/sendMessage`,
			{
				chat_id: target.chat_id,
				text,
				parse_mode: 'HTML',
				disable_web_page_preview: true
			},
			timeoutMs,
			egress
		);
	}

	if (target.type === 'pushover') {
		const priority = PUSHOVER_PRIORITY[target.priority ?? 'default'] ?? 0;
		const body: Record<string, unknown> = {
			token: target.token,
			user: target.user,
			title: msg.title,
			message: clip(msg.body),
			priority
		};
		if (msg.clickUrl) {
			body.url = msg.clickUrl;
			body.url_title = 'View status';
		}
		if (priority === 2) {
			// Emergency priority is rejected without retry/expire.
			body.retry = 60;
			body.expire = 600;
		}
		return jsonPost('https://api.pushover.net/1/messages.json', body, timeoutMs, egress);
	}

	if (!target.url) return { ok: false, status: null, error: 'target url is not set' };

	if (target.type === 'ntfy') {
		const headers: Record<string, string> = {
			Title: msg.title,
			Priority: NTFY_PRIORITY[target.priority ?? 'default'] ?? '3',
			Tags: [...msg.tags, ...(target.tags ?? [])].join(','),
			...target.headers
		};
		const click = target.click_url ?? msg.clickUrl;
		if (click) headers.Click = click;
		if (target.token) headers.Authorization = ntfyAuth(target.token);
		return post(target.url, { method: 'POST', headers, body: msg.body }, timeoutMs, egress);
	}

	if (target.type === 'unifiedpush') {
		// UnifiedPush: the endpoint URL is the credential; body is the
		// message verbatim.
		return post(
			target.url,
			{
				method: 'POST',
				headers: { 'content-type': 'text/plain; charset=utf-8' },
				body: `${msg.title}\n${msg.body}`
			},
			timeoutMs,
			egress
		);
	}

	if (target.type === 'slack') {
		const text = clip(`${msg.title}\n${msg.body}`);
		return jsonPost(
			target.url,
			{
				text,
				blocks: [
					{
						type: 'section',
						text: { type: 'mrkdwn', text: clip(`*${msg.title}*\n${msg.body}`) }
					}
				]
			},
			timeoutMs,
			egress
		);
	}

	if (target.type === 'discord') {
		return jsonPost(
			target.url,
			{
				content: clip(msg.title),
				embeds: [
					{
						title: msg.title,
						description: clip(msg.body),
						color: EVENT_COLOR[msg.event] ?? 0x3b82f6,
						...(msg.clickUrl ? { url: msg.clickUrl } : {})
					}
				]
			},
			timeoutMs,
			egress
		);
	}

	if (target.type === 'teams') {
		const color = (EVENT_COLOR[msg.event] ?? 0x3b82f6).toString(16).padStart(6, '0');
		return jsonPost(
			target.url,
			{
				'@type': 'MessageCard',
				'@context': 'http://schema.org/extensions',
				themeColor: color,
				summary: msg.title,
				sections: [{ activityTitle: msg.title, text: clip(msg.body) }]
			},
			timeoutMs,
			egress
		);
	}

	if (target.type === 'gotify') {
		const base = target.url.replace(/\/+$/, '');
		return jsonPost(
			`${base}/message?token=${encodeURIComponent(target.token ?? '')}`,
			{
				title: msg.title,
				message: clip(msg.body),
				priority: GOTIFY_PRIORITY[target.priority ?? 'default'] ?? 5
			},
			timeoutMs,
			egress
		);
	}

	// Generic webhook: JSON document, optional Authorization + headers.
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		...target.headers
	};
	if (target.token) headers.Authorization = target.token;
	return post(
		target.url,
		{
			method: 'POST',
			headers,
			body: JSON.stringify({
				title: msg.title,
				body: msg.body,
				priority: msg.priority,
				tags: msg.tags,
				click_url: msg.clickUrl
			})
		},
		timeoutMs,
		egress
	);
}
