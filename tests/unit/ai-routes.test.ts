import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { Runtime } from '$lib/server/runtime';
import type { PublicUser } from '$lib/shared/auth';

const ref = vi.hoisted(() => ({
	rt: undefined as unknown as Runtime,
	aiEnabled: true,
	mcpEnabled: true
}));

vi.mock('$lib/server/runtime', async () => {
	process.env.WHARFINGER_SECRET_KEY = 'ai-route-test-key';
	const { mkdtempSync } = await import('node:fs');
	const { join } = await import('node:path');
	const { tmpdir } = await import('node:os');
	const dir = mkdtempSync(join(tmpdir(), 'q4s-ai-'));
	process.env.WHARFINGER_DATA_DIR = dir;
	const { openDb } = await import('$lib/server/store/db');
	const { ApiKeyStore } = await import('$lib/server/store/apikeys');
	const db = openDb(dir);
	ref.rt = {
		apiKeys: new ApiKeyStore(db),
		audit: { log: vi.fn(() => Promise.resolve()) },
		egress: { dispatcher: {}, lookup: () => undefined, allowLinkLocal: () => false },
		snapshot: {
			current: () =>
				Promise.resolve({
					snapshot: {
						groups: [
							{
								name: 'g',
								services: [
									{
										id: 's1',
										name: 'api',
										status: 'operational',
										latencyMs: 10,
										uptime: { d24: 100, d7: null, d30: null, d90: null },
										inMaintenance: false,
										lastDetail: null,
										certDays: null
									}
								]
							}
						],
						incidents: { active: [], recent: [] }
					}
				})
		},
		agents: { list: () => Promise.resolve([]) },
		deploys: { listApps: () => Promise.resolve([]) },
		jobs: { list: () => Promise.resolve([]) },
		get config() {
			return {
				ingress: { online_seconds: 90 },
				ai: {
					enabled: ref.aiEnabled,
					base_url: 'https://llm.example.com/v1',
					api_key: 'k',
					model: 'm',
					max_tokens: 128,
					temperature: 0.2,
					timeout_ms: 5000,
					mcp_enabled: ref.mcpEnabled
				}
			};
		},
		db
	} as unknown as Runtime;
	return { getRuntime: () => ref.rt };
});

const { POST: askRoute } = await import('../../src/routes/admin/api/ai/ask/+server');
const { POST: mcpRoute } = await import('../../src/routes/api/mcp/+server');

const admin = { id: 7, username: 'root', role: 'admin' } as PublicUser;

function event(body: unknown, perms: Set<string> | null = new Set(['ai.use'])): RequestEvent {
	return {
		locals: perms === null ? {} : { user: admin, perms },
		url: new URL('http://test/admin/api/ai/ask'),
		request: new Request('http://test/admin/api/ai/ask', {
			method: 'POST',
			body: JSON.stringify(body)
		}),
		getClientAddress: () => '127.0.0.1'
	} as unknown as RequestEvent;
}

function mcpEvent(msg: unknown, auth?: string): RequestEvent {
	return {
		request: new Request('http://test/api/mcp', {
			method: 'POST',
			headers: auth ? { authorization: auth } : {},
			body: JSON.stringify(msg)
		})
	} as unknown as RequestEvent;
}

function stubProvider(answer: unknown): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(() =>
			Promise.resolve(
				new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }), {
					status: 200
				})
			)
		)
	);
}

describe('ai ask route', () => {
	it('requires ai.use', async () => {
		await expect(askRoute(event({ question: 'q' }, new Set()) as never)).rejects.toMatchObject({
			status: 403
		});
		await expect(askRoute(event({ question: 'q' }, null) as never)).rejects.toMatchObject({
			status: 401
		});
	});

	it('404s when ai is disabled', async () => {
		ref.aiEnabled = false;
		const res = await askRoute(event({ question: 'status?' }) as never);
		expect(res.status).toBe(404);
		ref.aiEnabled = true;
	});

	it('validates the question', async () => {
		for (const body of [{}, { question: '' }, { question: 'x'.repeat(2001) }, { question: 5 }]) {
			const res = await askRoute(event(body) as never);
			expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(422);
		}
	});

	it('502s on provider failure and 200s with the answer', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.reject(new Error('connect refused')))
		);
		const bad = await askRoute(event({ question: 'is api up?' }) as never);
		expect(bad.status).toBe(502);

		stubProvider('api is up');
		const ok = await askRoute(event({ question: 'is api up?' }) as never);
		expect(ok.status).toBe(200);
		const body = (await ok.json()) as { answer: string; sources: string[]; generated: boolean };
		expect(body.answer).toBe('api is up');
		expect(body.sources).toContain('status snapshot');
		expect(body.generated).toBe(true);
		vi.unstubAllGlobals();
	});

	it('rate limits per user', async () => {
		stubProvider('ok');
		let last = 0;
		for (let i = 0; i < 14; i++) {
			last = (await askRoute(event({ question: `q${i}` }) as never)).status;
		}
		expect(last).toBe(429);
		vi.unstubAllGlobals();
	});
});

describe('mcp route', () => {
	it('404s when mcp is disabled and 401s without a key', async () => {
		ref.mcpEnabled = false;
		expect((await mcpRoute(mcpEvent({ id: 1, method: 'initialize' }) as never)).status).toBe(404);
		ref.mcpEnabled = true;
		expect((await mcpRoute(mcpEvent({ id: 1, method: 'initialize' }) as never)).status).toBe(401);
	});

	it('serves tools/list to a read-scoped key', async () => {
		const { token } = await ref.rt.apiKeys.create('mcp', ['read'], 'test');
		const res = await mcpRoute(
			mcpEvent({ id: 1, method: 'tools/list' }, `Bearer ${token}`) as never
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { tools: unknown[] } };
		expect(body.result.tools.length).toBeGreaterThan(0);
	});

	it('rejects a write-only key and notifications return 202', async () => {
		const { token } = await ref.rt.apiKeys.create('writer', ['write'], 'test');
		expect(
			(await mcpRoute(mcpEvent({ id: 1, method: 'tools/list' }, `Bearer ${token}`) as never)).status
		).toBe(403);
		const { token: rt } = await ref.rt.apiKeys.create('reader', ['read'], 'test');
		const res = await mcpRoute(
			mcpEvent({ method: 'notifications/initialized' }, `Bearer ${rt}`) as never
		);
		expect(res.status).toBe(202);
	});
});
