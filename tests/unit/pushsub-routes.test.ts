import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { Runtime } from '$lib/server/runtime';
import type { PushSubStore } from '$lib/server/store/pushsubs';

// Route coverage for the push-subscription endpoints and the
// notification-center feed. Real store on a temp db + temp data dir;
// the rest of the runtime is stubbed.
const ref = vi.hoisted(() => ({
	rt: undefined as unknown as Runtime,
	pushSubs: undefined as unknown as PushSubStore,
	resolveSession: undefined as unknown as ReturnType<typeof vi.fn>
}));

vi.mock('$lib/server/runtime', async () => {
	const { mkdtempSync } = await import('node:fs');
	const { join } = await import('node:path');
	const { tmpdir } = await import('node:os');
	const dir = mkdtempSync(join(tmpdir(), 'wf-push-routes-'));
	process.env.WHARFINGER_DATA_DIR = dir;
	const { openDb } = await import('$lib/server/store/db');
	const { PushSubStore } = await import('$lib/server/store/pushsubs');
	const db = openDb(dir);
	// user_id is FK'd to users; seed the rows binding tests point at.
	for (const id of [42, 7]) {
		db.prepare(
			'INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)'
		).run(id, `u${id}`, 'x', 'viewer', 1);
	}
	ref.pushSubs = new PushSubStore(db);
	ref.resolveSession = vi.fn((token: string) =>
		Promise.resolve(
			token === 'good-session' ? { user: { id: 42, username: 'op' }, tokenHash: 'h' } : null
		)
	);
	ref.rt = {
		db,
		pushSubs: ref.pushSubs,
		config: { notifications: { enabled: true } },
		sessions: { resolve: ref.resolveSession },
		sessionTtlMs: () => 3600_000,
		audit: {
			log: vi.fn(() => Promise.resolve()),
			// Nonempty on purpose: the feed must never surface audit rows.
			list: vi.fn(() =>
				Promise.resolve({
					entries: [{ id: 1, actor: 'op', action: 'config.save', target: 'site', at: 9000 }],
					total: 1
				})
			)
		},
		chat: {
			listRoomsFor: vi.fn(() =>
				Promise.resolve([
					{
						id: 'r1',
						kind: 'room',
						name: 'ops',
						createdBy: 1,
						createdAt: 1000,
						members: [],
						unread: 3,
						preview: { id: 9, body: 'hi', at: 5000, username: 'a', deleted: false }
					}
				])
			)
		},
		snapshot: {
			current: vi.fn(() =>
				Promise.resolve({
					snapshot: {
						incidents: {
							active: [
								{
									id: 'i1',
									title: 'API outage',
									severity: 'major',
									services: ['api'],
									startedAt: new Date(4000).toISOString(),
									resolvedAt: null,
									updates: [],
									source: 'auto'
								}
							]
						}
					}
				})
			)
		},
		notifyLog: {
			recent: vi.fn(() =>
				Promise.resolve([
					{
						id: 1,
						target: 'hook1',
						kind: 'webhook',
						event: 'down',
						serviceId: 'api',
						ok: false,
						status: 500,
						error: 'HTTP 500',
						at: 3000
					}
				])
			)
		}
	} as unknown as Runtime;
	return { getRuntime: () => ref.rt };
});

const { GET, POST, DELETE } = await import('../../src/routes/api/push-subscribe/+server');
const { GET: listSubs } = await import('../../src/routes/admin/api/push-subs/+server');
const { DELETE: revokeSub } = await import('../../src/routes/admin/api/push-subs/[id]/+server');
const { GET: feed } = await import('../../src/routes/admin/api/notifications/+server');

// Same intersection trick as the chat route tests: one fake event
// satisfies every handler signature under test.
type PushRouteEvent = RequestEvent<Record<string, string>, '/api/push-subscribe'> &
	RequestEvent<Record<string, string>, '/admin/api/push-subs'> &
	RequestEvent<{ id: string }, '/admin/api/push-subs/[id]'> &
	RequestEvent<Record<string, string>, '/admin/api/notifications'>;

const USER = { id: 42, username: 'op' };

function event(opts: {
	url: string;
	method?: string;
	body?: unknown;
	rawBody?: string;
	params?: Record<string, string>;
	user?: { id: number; username: string } | null;
	perms?: string[];
	sessionCookie?: string;
}): PushRouteEvent {
	const payload = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
	return {
		locals:
			opts.user === null || opts.user === undefined
				? { perms: null }
				: { user: opts.user, perms: new Set(opts.perms ?? []) },
		params: opts.params ?? {},
		url: new URL(opts.url),
		cookies: { get: () => opts.sessionCookie ?? null },
		request: new Request(opts.url, {
			method: opts.method ?? 'GET',
			body: payload,
			headers: payload === undefined ? {} : { 'content-type': 'application/json' }
		}),
		getClientAddress: () => '127.0.0.1'
	} as unknown as PushRouteEvent;
}

let seq = 0;
function subBody(endpoint?: string): Record<string, unknown> {
	seq += 1;
	const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	const der = kp.publicKey.export({ format: 'der', type: 'spki' });
	return {
		endpoint: endpoint ?? `https://push.example.com/send/${seq}`,
		keys: {
			p256dh: der.subarray(-65).toString('base64url'),
			auth: randomBytes(16).toString('base64url')
		},
		userAgent: 'vitest'
	};
}

describe('public push-subscribe route', () => {
	it('GET returns the vapid public key and enabled flag', async () => {
		const res = await GET(event({ url: 'http://test/api/push-subscribe' }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { vapidPublicKey: string; enabled: boolean };
		expect(body.vapidPublicKey.length).toBeGreaterThan(40);
		expect(body.enabled).toBe(true);
	});

	it('POST stores an anonymous subscription', async () => {
		const res = await POST(
			event({ url: 'http://test/api/push-subscribe', method: 'POST', body: subBody() })
		);
		expect(res.status).toBe(200);
		expect(await ref.pushSubs.active()).toHaveLength(1);
		expect((await ref.pushSubs.active())[0].userId).toBeNull();
	});

	it('POST binds user_id when the session cookie resolves', async () => {
		const res = await POST(
			event({
				url: 'http://test/api/push-subscribe',
				method: 'POST',
				body: subBody(),
				sessionCookie: 'good-session'
			})
		);
		expect(res.status).toBe(200);
		const subs = await ref.pushSubs.listForUser(42);
		expect(subs).toHaveLength(1);
		expect(subs[0].userAgent).toBe('vitest');
	});

	it('POST rejects non-https endpoints, bad keys, and bad json', async () => {
		const http = await POST(
			event({
				url: 'http://test/api/push-subscribe',
				method: 'POST',
				body: subBody('http://push.example.com/x')
			})
		);
		expect(http.status).toBe(422);

		const badKeys = await POST(
			event({
				url: 'http://test/api/push-subscribe',
				method: 'POST',
				body: { endpoint: 'https://push.example.com/x', keys: { p256dh: 'x', auth: 'y' } }
			})
		);
		expect(badKeys.status).toBe(422);

		const linkLocal = await POST(
			event({
				url: 'http://test/api/push-subscribe',
				method: 'POST',
				body: subBody('https://169.254.169.254/x')
			})
		);
		expect(linkLocal.status).toBe(422);

		const malformed = await POST(
			event({
				url: 'http://test/api/push-subscribe',
				method: 'POST',
				rawBody: '{not-json'
			})
		);
		expect(malformed.status).toBe(400);
	});

	it('DELETE removes a subscription by endpoint', async () => {
		const ep = 'https://push.example.com/send/gone';
		await POST(
			event({
				url: 'http://test/api/push-subscribe',
				method: 'POST',
				body: subBody(ep)
			})
		);
		const res = await DELETE(
			event({
				url: 'http://test/api/push-subscribe',
				method: 'DELETE',
				body: { endpoint: ep }
			})
		);
		expect(res.status).toBe(200);
		expect((await ref.pushSubs.active()).some((s) => s.endpoint === ep)).toBe(false);
	});
});

describe('admin push-subs routes', () => {
	it('rejects unauthenticated calls', async () => {
		await expect(
			listSubs(event({ url: 'http://test/admin/api/push-subs', user: null }))
		).rejects.toMatchObject({ status: 401 });
		await expect(
			revokeSub(
				event({
					url: 'http://test/admin/api/push-subs/x',
					method: 'DELETE',
					params: { id: 'x'.repeat(24) },
					user: null
				})
			)
		).rejects.toMatchObject({ status: 401 });
	});

	it('lists only the caller own subscriptions', async () => {
		const res = await listSubs(event({ url: 'http://test/admin/api/push-subs', user: USER }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { subs: { userAgent: string | null }[] };
		expect(body.subs).toHaveLength(1);
		expect(body.subs[0].userAgent).toBe('vitest');
	});

	it('revokes own subscriptions and not others', async () => {
		const own = (await ref.pushSubs.listForUser(42))[0];
		const otherKeys = subBody().keys as { p256dh: string; auth: string };
		const other = await ref.pushSubs.add({
			endpoint: 'https://push.example.com/send/other',
			p256dh: otherKeys.p256dh,
			auth: otherKeys.auth,
			userId: 7,
			userAgent: null
		});
		const denied = await revokeSub(
			event({
				url: `http://test/admin/api/push-subs/${other!.id}`,
				method: 'DELETE',
				params: { id: other!.id },
				user: USER
			})
		);
		expect(denied.status).toBe(404);

		const ok = await revokeSub(
			event({
				url: `http://test/admin/api/push-subs/${own.id}`,
				method: 'DELETE',
				params: { id: own.id },
				user: USER
			})
		);
		expect(ok.status).toBe(200);
		expect(await ref.pushSubs.listForUser(42)).toHaveLength(0);
	});
});

describe('admin notifications feed', () => {
	it('rejects unauthenticated calls', async () => {
		await expect(
			feed(event({ url: 'http://test/admin/api/notifications', user: null }))
		).rejects.toMatchObject({ status: 401 });
	});

	it('composes chat, incident, and delivery items', async () => {
		const res = await feed(
			event({
				url: 'http://test/admin/api/notifications',
				user: USER,
				perms: ['status.view']
			})
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			items: { kind: string; title: string; at: number; href: string | null }[];
		};
		const kinds = body.items.map((i) => i.kind);
		expect(kinds).toContain('chat');
		expect(kinds).toContain('incident');
		expect(kinds).toContain('delivery');
		// The audit stub returns a row; routine writes must not leak
		// into the notification feed.
		expect(kinds).not.toContain('audit');
		expect(body.items.find((i) => i.kind === 'chat')?.href).toBe('/chat');
	});
});
