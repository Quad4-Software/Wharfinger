import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '$lib/server/store/db';
import { PushSubStore } from '$lib/server/store/pushsubs';
import { sendPush, vapidKeys, vapidSubject } from '$lib/server/notify/webpush';
import { NotifyDispatcher } from '$lib/server/notify/dispatcher';
import { NotificationLog } from '$lib/server/notify/log';
import { makeEgress } from '$lib/server/http/egress';
import type { StatusConfig } from '$lib/server/config/schema';

const egress = makeEgress(() => false);

function tmpDb(): DatabaseSync {
	return openDb(mkdtempSync(join(tmpdir(), 'wf-pushsubs-')));
}

// push_subscriptions.user_id references users(id), so tests that
// exercise user binding need a real row to point at.
function seedUser(db: DatabaseSync, id: number): void {
	db.prepare(
		'INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)'
	).run(id, `u${id}`, 'x', 'viewer', 1);
}

/** A real P-256 subscription keypair so web-push can encrypt. */
function subKeys(): { p256dh: string; auth: string } {
	const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	const der = kp.publicKey.export({ format: 'der', type: 'spki' });
	return {
		p256dh: der.subarray(-65).toString('base64url'),
		auth: randomBytes(16).toString('base64url')
	};
}

let seq = 0;
function endpoint(): string {
	seq += 1;
	return `https://push.example.com/send/${seq}`;
}

function mockFetch(status = 201): { url: string; init: RequestInit }[] {
	const calls: { url: string; init: RequestInit }[] = [];
	vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return Promise.resolve(new Response('ok', { status }));
	});
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('PushSubStore', () => {
	it('adds, lists, and scopes subscriptions', async () => {
		const db = tmpDb();
		seedUser(db, 7);
		const store = new PushSubStore(db);
		const keys = subKeys();
		const ep = endpoint();
		const sub = await store.add({
			endpoint: ep,
			...keys,
			userId: 7,
			userAgent: 'test-agent'
		});
		expect(sub).not.toBeNull();
		expect(sub?.endpoint).toBe(ep);
		expect(sub?.userId).toBe(7);

		expect(await store.listForUser(7)).toHaveLength(1);
		expect(await store.listForUser(8)).toHaveLength(0);
		expect(await store.active()).toHaveLength(1);
	});

	it('re-add refreshes keys, rebinds the user, and clears the tombstone', async () => {
		const db = tmpDb();
		seedUser(db, 1);
		seedUser(db, 2);
		const store = new PushSubStore(db);
		const ep = endpoint();
		const first = await store.add({
			endpoint: ep,
			...subKeys(),
			userId: 1,
			userAgent: null
		});
		await store.disable(first!.id);
		const next = subKeys();
		const again = await store.add({ endpoint: ep, ...next, userId: 2, userAgent: 'ua' });
		expect(again?.id).toBe(first!.id);
		expect(again?.userId).toBe(2);
		expect(again?.p256dh).toBe(next.p256dh);
		expect(again?.disabledAt).toBeNull();
		expect(await store.active()).toHaveLength(1);
	});

	it('markSeen bumps last_seen_at and disable hides from active', async () => {
		const db = tmpDb();
		const store = new PushSubStore(db);
		const ep = endpoint();
		const sub = await store.add({ endpoint: ep, ...subKeys(), userId: null, userAgent: null });
		db.prepare('UPDATE push_subscriptions SET last_seen_at = 1000 WHERE id = ?').run(sub!.id);
		const before = (await store.active())[0];
		expect(before.lastSeenAt).toBe(1000);
		await store.markSeen(ep);
		const after = (await store.active())[0];
		expect(after.lastSeenAt).toBeGreaterThan(1000);
		await store.disable(sub!.id);
		expect(await store.active()).toHaveLength(0);
	});

	it('remove deletes by endpoint, removeForUser is owner-scoped', async () => {
		const db = tmpDb();
		seedUser(db, 1);
		seedUser(db, 2);
		const store = new PushSubStore(db);
		const a = await store.add({
			endpoint: endpoint(),
			...subKeys(),
			userId: 1,
			userAgent: null
		});
		const b = await store.add({
			endpoint: endpoint(),
			...subKeys(),
			userId: 2,
			userAgent: null
		});
		// Another user cannot revoke the row.
		expect(await store.removeForUser(a!.id, 2)).toBe(false);
		expect(await store.removeForUser(a!.id, 1)).toBe(true);
		expect(await store.remove(b!.endpoint)).toBe(true);
		expect(await store.active()).toHaveLength(0);
	});

	it('prune drops tombstoned and stale subscriptions', async () => {
		const db = tmpDb();
		const store = new PushSubStore(db);
		const stale = await store.add({
			endpoint: endpoint(),
			...subKeys(),
			userId: null,
			userAgent: null
		});
		const dead = await store.add({
			endpoint: endpoint(),
			...subKeys(),
			userId: null,
			userAgent: null
		});
		await store.add({ endpoint: endpoint(), ...subKeys(), userId: null, userAgent: null });
		db.prepare('UPDATE push_subscriptions SET last_seen_at = 1 WHERE id = ?').run(stale!.id);
		await store.disable(dead!.id);
		await store.prune(Date.now() - 90 * 86_400_000);
		const rest = await store.active();
		expect(rest).toHaveLength(1);
	});
});

describe('vapidKeys', () => {
	it('generates a persistent 0600 keypair file', () => {
		const dir = mkdtempSync(join(tmpdir(), 'wf-vapid-'));
		const a = vapidKeys(dir);
		const b = vapidKeys(dir);
		expect(a.publicKey).toBe(b.publicKey);
		const file = JSON.parse(readFileSync(join(dir, 'vapid.json'), 'utf8')) as {
			publicKey?: string;
			privateKey?: string;
		};
		expect(file.publicKey).toBe(a.publicKey);
		expect(file.privateKey).toBe(a.privateKey);
		// owner-only file mode
		expect(statSync(join(dir, 'vapid.json')).mode & 0o777).toBe(0o600);
	});

	it('derives the vapid subject from an https site url', () => {
		expect(vapidSubject('https://status.example.com')).toBe('https://status.example.com');
		expect(vapidSubject(null)).toBe('mailto:wharfinger@localhost');
		expect(vapidSubject('http://insecure.example.com')).toBe('mailto:wharfinger@localhost');
	});
});

describe('sendPush', () => {
	const deps = () => ({
		keys: vapidKeys(mkdtempSync(join(tmpdir(), 'wf-vapid-'))),
		subject: 'mailto:test@example.com',
		urgency: 'high' as const,
		timeoutMs: 5000,
		egress
	});

	it('posts an encrypted vapid request through egress', async () => {
		const calls = mockFetch(201);
		const db = tmpDb();
		const store = new PushSubStore(db);
		const sub = await store.add({
			endpoint: endpoint(),
			...subKeys(),
			userId: null,
			userAgent: null
		});
		const r = await sendPush(sub!, JSON.stringify({ title: 't', body: 'b' }), deps());
		expect(r.ok).toBe(true);
		expect(r.status).toBe(201);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(sub!.endpoint);
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers.Authorization).toContain('vapid');
		expect(headers['Content-Encoding']).toBe('aes128gcm');
		expect((calls[0].init.body as Buffer).length).toBeGreaterThan(0);
		// The undici egress dispatcher is attached.
		expect((calls[0].init as { dispatcher?: unknown }).dispatcher).toBe(egress.dispatcher);
	});

	it('reports non-2xx with the status code', async () => {
		mockFetch(410);
		const store = new PushSubStore(tmpDb());
		const sub = await store.add({
			endpoint: endpoint(),
			...subKeys(),
			userId: null,
			userAgent: null
		});
		const r = await sendPush(sub!, 'x', deps());
		expect(r.ok).toBe(false);
		expect(r.status).toBe(410);
	});

	it('refuses subs without encryption keys and blocked hosts', async () => {
		const calls = mockFetch(201);
		const store = new PushSubStore(tmpDb());
		const noKeys = await store.add({
			endpoint: endpoint(),
			p256dh: subKeys().p256dh,
			auth: subKeys().auth,
			userId: null,
			userAgent: null
		});
		noKeys!.p256dh = null;
		const r1 = await sendPush(noKeys!, 'x', deps());
		expect(r1.ok).toBe(false);
		expect(r1.error).toContain('encryption keys');

		const blocked = await store.add({
			endpoint: 'https://169.254.169.254/latest',
			...subKeys(),
			userId: null,
			userAgent: null
		});
		const r2 = await sendPush(blocked!, 'x', deps());
		expect(r2.ok).toBe(false);
		expect(r2.error).toContain('egress');
		expect(calls).toHaveLength(0);
	});
});

describe('NotifyDispatcher webpush fanout', () => {
	function cfg(): StatusConfig {
		return {
			site: { name: 'Test Co', url: 'https://status.example.com' },
			notifications: {
				enabled: true,
				cooldown_seconds: 0,
				timeout_ms: 8000,
				retries: 0,
				targets: []
			}
		} as unknown as StatusConfig;
	}

	function setup(status: number) {
		const db = tmpDb();
		const log = new NotificationLog(db);
		const subs = new PushSubStore(db);
		const keys = vapidKeys(mkdtempSync(join(tmpdir(), 'wf-vapid-')));
		const d = new NotifyDispatcher(cfg, log, egress, undefined, {
			subs,
			vapid: () => keys
		});
		const calls = mockFetch(status);
		return { d, log, subs, calls };
	}

	it('sends to every live subscription and writes one log row', async () => {
		const { d, log, subs, calls } = setup(201);
		await subs.add({ endpoint: endpoint(), ...subKeys(), userId: null, userAgent: null });
		await subs.add({ endpoint: endpoint(), ...subKeys(), userId: null, userAgent: null });
		await d.notify({ event: 'down', serviceId: 'web', serviceName: 'Web' });
		expect(calls).toHaveLength(2);
		const entries = await log.recent();
		expect(entries).toHaveLength(1);
		expect(entries[0].kind).toBe('webpush');
		expect(entries[0].ok).toBeTruthy();
	});

	it('tombstones endpoints the push service reports as gone', async () => {
		const { d, subs } = setup(410);
		const sub = await subs.add({
			endpoint: endpoint(),
			...subKeys(),
			userId: null,
			userAgent: null
		});
		await d.notify({ event: 'down', serviceId: 'web', serviceName: 'Web' });
		const rows = await subs.active();
		expect(rows).toHaveLength(0);
		// The row is tombstoned, not deleted: prune sweeps it later.
		expect(sub).not.toBeNull();
	});

	it('skips fanout when no subscriptions exist', async () => {
		const { d, log, calls } = setup(201);
		await d.notify({ event: 'down', serviceId: 'web', serviceName: 'Web' });
		expect(calls).toHaveLength(0);
		expect(await log.recent()).toHaveLength(0);
	});
});
