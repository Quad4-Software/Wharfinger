import { describe, expect, it, vi } from 'vitest';
import type { Runtime } from '$lib/server/runtime';
import { aiChat, aiConfigured } from '$lib/server/ai/provider';
import { buildContext, sanitize } from '$lib/server/ai/context';
import { parseSuggestions, resolveSuggestions, SUGGEST_KINDS } from '$lib/server/ai/suggest';
import { handleMcp, MCP_TOOLS } from '$lib/server/ai/mcp';
import type { Egress } from '$lib/server/http/egress';

const egress = {
	dispatcher: {},
	lookup: () => undefined,
	allowLinkLocal: () => false
} as unknown as Egress;

const ai = {
	enabled: true,
	base_url: 'https://llm.example.com/v1',
	api_key: 'k',
	model: 'm1',
	max_tokens: 512,
	temperature: 0.2,
	timeout_ms: 5000,
	mcp_enabled: false
};

function rt(over: Partial<Runtime> = {}): Runtime {
	return {
		config: { ingress: { online_seconds: 90 }, ai },
		snapshot: {
			current: () =>
				Promise.resolve({
					snapshot: {
						groups: [
							{
								name: 'core',
								services: [
									{
										id: 'svc1',
										name: 'api',
										status: 'major_outage',
										latencyMs: null,
										uptime: { d24: 98.5, d7: null, d30: null, d90: null },
										inMaintenance: false,
										lastDetail: 'HTTP 502',
										certDays: null
									},
									{
										id: 'svc2',
										name: 'web',
										status: 'operational',
										latencyMs: 120,
										uptime: { d24: 100, d7: null, d30: null, d90: null },
										inMaintenance: false,
										lastDetail: 'HTTP 200',
										certDays: 40
									}
								]
							}
						],
						incidents: {
							active: [
								{
									id: 'inc1',
									title: 'API outage',
									severity: 'major',
									services: ['api'],
									startedAt: 'now',
									resolvedAt: null,
									source: 'auto',
									updates: [{ at: 't1', message: 'investigating' }]
								}
							],
							recent: []
						}
					}
				})
		},
		agents: {
			list: () =>
				Promise.resolve([
					{
						id: 'ag1',
						name: 'web-1',
						lastSeenAt: Date.now(),
						alerts: {},
						mutedUntil: null,
						revokedAt: null,
						meta: { version: '0.3.0', os: 'linux' },
						lastPayload: null
					}
				])
		},
		deploys: {
			listApps: () => Promise.resolve([{ id: 'app1', name: 'shop', agentId: 'ag1' }]),
			releases: () =>
				Promise.resolve([
					{ id: 'rel_new', status: 'live' },
					{ id: 'rel_old', status: 'superseded' }
				])
		},
		jobs: {
			list: () =>
				Promise.resolve([
					{ id: 1, kind: 'deploy', status: 'succeeded', target: 'ag1', createdAt: 1 }
				])
		},
		...over
	} as unknown as Runtime;
}

describe('ai provider', () => {
	it('is configured only when enabled with a url and model', () => {
		expect(aiConfigured(ai)).toBe(true);
		expect(aiConfigured({ ...ai, enabled: false })).toBe(false);
		expect(aiConfigured({ ...ai, base_url: '' })).toBe(false);
		expect(aiConfigured({ ...ai, model: '' })).toBe(false);
	});

	it('posts chat completions through the egress dispatcher', async () => {
		const fetchSpy = vi.fn(() =>
			Promise.resolve(
				new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), {
					status: 200
				})
			)
		);
		vi.stubGlobal('fetch', fetchSpy);
		const res = await aiChat(ai, egress, [{ role: 'user', content: 'hi' }]);
		expect(res).toEqual({ ok: true, text: 'hello', error: null });
		const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://llm.example.com/v1/chat/completions');
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
		expect((init as { dispatcher?: unknown }).dispatcher).toBe(egress.dispatcher);
		vi.unstubAllGlobals();
	});

	it('refuses metadata-endpoint providers without allow_link_local', async () => {
		const res = await aiChat({ ...ai, base_url: 'http://169.254.169.254/v1' }, egress, [
			{ role: 'user', content: 'hi' }
		]);
		expect(res.ok).toBe(false);
		expect(res.error).toContain('egress');
	});

	it('allows a loopback model (Ollama-style) by default', async () => {
		const fetchSpy = vi.fn(() =>
			Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })))
		);
		vi.stubGlobal('fetch', fetchSpy);
		const res = await aiChat(
			{ ...ai, base_url: 'http://127.0.0.1:11434/v1', api_key: '' },
			egress,
			[{ role: 'user', content: 'hi' }]
		);
		expect(res.ok).toBe(true);
		vi.unstubAllGlobals();
	});
});

describe('prompt context', () => {
	it('sanitizes metacharacters and control chars out of fields', () => {
		expect(sanitize('a<b>"c`d\'e\x00f\n g')).toBe('a b c d e f g');
		expect(sanitize('x'.repeat(500), 10)).toHaveLength(10);
	});

	it('builds a bounded quoted context with sources', async () => {
		const { context, sources } = await buildContext(rt());
		expect(context).toContain('service "api"');
		expect(context).toContain('status=major_outage');
		expect(context).toContain('incident "API outage"');
		expect(context).toContain('agent "web-1"');
		expect(sources).toContain('status snapshot');
		expect(sources).toContain('incidents');
	});
});

describe('suggested actions', () => {
	it('parses a JSON suggestions block out of prose', () => {
		const text =
			'sure! {"suggestions":[{"kind":"agent.service.restart","agent":"web-1","unit":"nginx","reason":"it is down"}]} done';
		const raw = parseSuggestions(text);
		expect(raw).toHaveLength(1);
		expect(raw[0].kind).toBe('agent.service.restart');
	});

	it('drops malformed output safely', () => {
		expect(parseSuggestions('no json here')).toEqual([]);
		expect(parseSuggestions('{"suggestions":"nope"}')).toEqual([]);
	});

	it('the suggest catalog stays a fixed allowlist', () => {
		expect([...SUGGEST_KINDS].sort()).toEqual(
			[
				'agent.packages.refresh',
				'agent.reboot',
				'agent.service.restart',
				'agent.service.start',
				'agent.service.stop',
				'deploy.redeploy',
				'deploy.rollback',
				'maintenance.open'
			].sort()
		);
	});

	it('resolves service verbs to audited task calls', async () => {
		const out = await resolveSuggestions(
			rt(),
			parseSuggestions(
				'{"suggestions":[{"kind":"agent.service.restart","agent":"web-1","unit":"nginx","reason":"flapping"}]}'
			)
		);
		expect(out).toHaveLength(1);
		expect(out[0].call).toEqual({
			method: 'POST',
			path: '/agents/ag1/task',
			body: { action: 'service.restart', unit: 'nginx' }
		});
		expect(out[0].danger).toBe(true);
	});

	it('drops unknown kinds and unresolved targets', async () => {
		const out = await resolveSuggestions(
			rt(),
			parseSuggestions(
				JSON.stringify({
					suggestions: [
						{ kind: 'host.rm-rf', reason: 'evil' },
						{ kind: 'agent.service.restart', agent: 'ghost', unit: 'nginx' },
						{ kind: 'agent.service.restart', agent: 'web-1', unit: 'bad;unit' },
						{ kind: 'deploy.redeploy', app: 'shop', reason: 'stale' }
					]
				})
			)
		);
		expect(out).toHaveLength(1);
		expect(out[0].kind).toBe('deploy.redeploy');
		expect(out[0].call?.path).toBe('/deploy/apps/app1/deploy');
	});

	it('picks the prior release for rollback', async () => {
		const out = await resolveSuggestions(
			rt(),
			parseSuggestions('{"suggestions":[{"kind":"deploy.rollback","app":"shop","reason":"bad"}]}')
		);
		expect(out[0].call?.body).toEqual({ rollbackTo: 'rel_old' });
	});
});

describe('mcp endpoint logic', () => {
	it('answers initialize and tools/list with the pinned catalog', async () => {
		const init = (await handleMcp(rt(), { id: 1, method: 'initialize' })) as {
			result: { serverInfo: { name: string }; capabilities: { tools: object } };
		};
		expect(init.result.serverInfo.name).toBe('wharfinger');
		const list = (await handleMcp(rt(), { id: 2, method: 'tools/list' })) as {
			result: { tools: { name: string }[] };
		};
		expect(list.result.tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));
	});

	it('runs a read-only tool and returns bounded sanitized text', async () => {
		const res = (await handleMcp(rt(), {
			id: 3,
			method: 'tools/call',
			params: { name: 'get_service', arguments: { name: 'api' } }
		})) as { result: { content: { text: string }[] } };
		const text = res.result.content[0].text;
		expect(text).toContain('"name": "api"');
		expect(text).toContain('"status": "major_outage"');
	});

	it('rejects unknown tools and methods', async () => {
		const bad = (await handleMcp(rt(), {
			id: 4,
			method: 'tools/call',
			params: { name: 'delete_everything' }
		})) as { error: { code: number } };
		expect(bad.error.code).toBe(-32602);
		const m = (await handleMcp(rt(), { id: 5, method: 'resources/list' })) as {
			error: { code: number };
		};
		expect(m.error.code).toBe(-32601);
	});

	it('returns null for notifications', async () => {
		expect(await handleMcp(rt(), { method: 'notifications/initialized' })).toBeNull();
	});
});
