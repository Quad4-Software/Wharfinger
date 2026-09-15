import type { StatusConfig } from '$lib/server/config/schema';
import {
	EGRESS_BLOCKED_DETAIL,
	blockedHost,
	type Egress,
	type FetchInit
} from '$lib/server/http/egress';

/**
 * OpenAI-compatible chat-completions adapter. The wire format covers
 * OpenAI, Anthropic-compatible proxies, Ollama, LM Studio, and
 * llama.cpp servers; other formats get their own adapter when needed.
 * Every call goes through the egress dispatcher with a fixed URL from
 * config, a bounded streamed response, and no redirect following.
 */

export interface AiMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface AiResult {
	ok: boolean;
	text: string;
	error: string | null;
}

const MAX_RESPONSE_BYTES = 256 * 1024;

export type AiConfig = StatusConfig['ai'];

/** True when the section is enabled and fully configured. */
export function aiConfigured(ai: AiConfig): boolean {
	return ai.enabled && ai.base_url !== '' && ai.model !== '';
}

async function readBounded(res: Response, max: number): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) return (await res.text()).slice(0, max);
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			total += value.byteLength;
			if (total > max) break;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return Buffer.concat(chunks).toString('utf8');
}

export async function aiChat(
	ai: AiConfig,
	egress: Egress,
	messages: AiMessage[]
): Promise<AiResult> {
	if (!aiConfigured(ai)) {
		return { ok: false, text: '', error: 'ai is not configured' };
	}
	let url: string;
	try {
		// Append rather than resolve: providers expose the endpoint
		// under a versioned prefix (…/v1/chat/completions).
		url = new URL(ai.base_url.replace(/\/+$/, '') + '/chat/completions').toString();
		if (!egress.allowLinkLocal() && blockedHost(new URL(url).hostname)) {
			return {
				ok: false,
				text: '',
				error: `${EGRESS_BLOCKED_DETAIL}; enable monitor.allow_link_local for a local model`
			};
		}
	} catch {
		return { ok: false, text: '', error: 'ai.base_url is not a valid url' };
	}

	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (ai.api_key) headers.authorization = `Bearer ${ai.api_key}`;
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				model: ai.model,
				messages,
				max_tokens: ai.max_tokens,
				temperature: ai.temperature,
				stream: false
			}),
			signal: AbortSignal.timeout(ai.timeout_ms),
			redirect: 'manual',
			dispatcher: egress.dispatcher
		} as FetchInit);
		const body = await readBounded(res, MAX_RESPONSE_BYTES).catch(() => '');
		if (res.status < 200 || res.status >= 300) {
			return { ok: false, text: '', error: `provider HTTP ${res.status}` };
		}
		const parsed = JSON.parse(body) as {
			choices?: { message?: { content?: unknown } }[];
		};
		const text = parsed.choices?.[0]?.message?.content;
		if (typeof text !== 'string' || text.trim() === '') {
			return { ok: false, text: '', error: 'provider returned no message' };
		}
		return { ok: true, text: text.trim(), error: null };
	} catch (err) {
		return { ok: false, text: '', error: err instanceof Error ? err.message : String(err) };
	}
}
