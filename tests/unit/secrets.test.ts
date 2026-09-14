import { describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { RequestEvent } from '@sveltejs/kit';
import type { Runtime } from '$lib/server/runtime';
import type { Permission } from '$lib/server/admin/authz';
import type { User } from '$lib/server/admin/users';
import { SecretError } from '$lib/server/secrets/store';

const ref = vi.hoisted(() => ({
	db: undefined as unknown as DatabaseSync,
	rt: undefined as unknown as Runtime
}));

vi.mock('$lib/server/runtime', async () => {
	process.env.WHARFINGER_SECRET_KEY = 'secrets-test-key-material';
	const { mkdtempSync } = await import('node:fs');
	const { join } = await import('node:path');
	const { tmpdir } = await import('node:os');
	const dir = mkdtempSync(join(tmpdir(), 'q4s-secrets-'));
	const { openDb } = await import('$lib/server/store/db');
	const { AuditStore } = await import('$lib/server/admin/audit');
	const db = openDb(dir);
	ref.db = db;
	ref.rt = {
		db,
		audit: new AuditStore(db)
	} as unknown as Runtime;
	return { getRuntime: () => ref.rt };
});

const { getSecretStore, resolveSecret } = await import('$lib/server/secrets/store');
const { GET: listSets, POST: createSet } =
	await import('../../src/routes/admin/api/secrets/+server');
const { PUT: putSet, DELETE: deleteSet } =
	await import('../../src/routes/admin/api/secrets/[id]/+server');
const { POST: revealKey } = await import('../../src/routes/admin/api/secrets/[id]/reveal/+server');

const admin: User = {
	id: 1,
	username: 'root',
	displayName: '',
	role: 'admin',
	totpEnabled: false,
	createdAt: 0,
	disabledAt: null,
	lastLoginAt: null
};

function event(opts: {
	method?: string;
	path?: string;
	body?: unknown;
	params?: Record<string, string>;
	user?: User | null;
	perms?: Permission[];
}): RequestEvent {
	const path = opts.path ?? '/admin/api/secrets';
	return {
		locals: {
			user: opts.user === undefined ? admin : opts.user,
			perms: new Set(opts.perms ?? ['secrets.manage'])
		},
		params: opts.params ?? {},
		url: new URL(`http://test${path}`),
		request: new Request(`http://test${path}`, {
			method: opts.method ?? 'GET',
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
		}),
		getClientAddress: () => '127.0.0.1'
	} as unknown as RequestEvent;
}

async function status(fn: (e: never) => unknown, ev: RequestEvent): Promise<number> {
	try {
		const res = await fn(ev as never);
		return (res as Response).status;
	} catch (e) {
		const s = (e as { status?: unknown }).status;
		return typeof s === 'number' ? s : 0;
	}
}

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

describe('SecretSetStore', () => {
	it('seals values at rest and lists keys only', () => {
		const store = getSecretStore(ref.db);
		const s = store.create('registry', { USER: 'bot', TOKEN: 's3cret-value' });
		expect(s.id).toMatch(/^sec_/);
		expect(s.keys.sort()).toEqual(['TOKEN', 'USER']);

		const row = ref.db.prepare('SELECT sealed FROM secret_sets WHERE id = ?').get(s.id) as {
			sealed: string;
		};
		expect(row.sealed.startsWith('v1.')).toBe(true);
		expect(row.sealed).not.toContain('s3cret-value');

		const listed = store.list().find((x) => x.id === s.id);
		expect(JSON.stringify(listed)).not.toContain('s3cret-value');
		expect(store.get(s.id)?.keys.sort()).toEqual(['TOKEN', 'USER']);
	});

	it('reveals single values and replaces the whole map on put', () => {
		const store = getSecretStore(ref.db);
		const s = store.create('swap', { OLD: 'gone', KEEP: 'stay' });
		expect(store.reveal(s.id, 'KEEP')).toBe('stay');

		const updated = store.put(s.id, { entries: { NEW: 'fresh' } });
		expect(updated.keys).toEqual(['NEW']);
		expect(store.reveal(s.id, 'OLD')).toBeNull();
		expect(store.reveal(s.id, 'KEEP')).toBeNull();
		expect(store.reveal(s.id, 'NEW')).toBe('fresh');
		expect(updated.updatedAt).toBeGreaterThanOrEqual(s.updatedAt);
	});

	it('renames without touching values and rejects bad input', () => {
		const store = getSecretStore(ref.db);
		const s = store.create('rename-me', { K: 'v' });
		const renamed = store.put(s.id, { name: 'renamed' });
		expect(renamed.name).toBe('renamed');
		expect(store.reveal(s.id, 'K')).toBe('v');

		expect(() => store.create('', {})).toThrow(SecretError);
		expect(() => store.create('bad-keys', { 'NOT VALID': 'x' })).toThrow(SecretError);
		try {
			store.put('sec_none', { name: 'x' });
			expect.unreachable();
		} catch (e) {
			expect((e as SecretError).status).toBe(404);
		}
	});

	it('deletes sets and resolves refs by name or id', () => {
		const store = getSecretStore(ref.db);
		const s = store.create('resolver', { PASSWORD: 'hunter2' });
		expect(resolveSecret(ref.db, `secret:${s.id}:PASSWORD`)).toBe('hunter2');
		expect(resolveSecret(ref.db, 'secret:resolver:PASSWORD')).toBe('hunter2');
		expect(resolveSecret(ref.db, 'secret:resolver:MISSING')).toBeNull();
		expect(resolveSecret(ref.db, 'secret:nope:PASSWORD')).toBeNull();
		expect(resolveSecret(ref.db, 'not-a-ref')).toBeNull();
		expect(store.remove(s.id)).toBe(true);
		expect(store.remove(s.id)).toBe(false);
	});
});

describe('secret routes', () => {
	it('rejects anonymous callers with 401', async () => {
		expect(await status(listSets, event({ user: null }))).toBe(401);
	});

	it('rejects users without secrets.manage with 403', async () => {
		expect(await status(listSets, event({ perms: [] }))).toBe(403);
		expect(await status(listSets, event({ perms: ['status.view'] }))).toBe(403);
	});

	it('creates a set without echoing values back', async () => {
		const res = await json(
			await createSet(
				event({
					method: 'POST',
					body: { name: 'api-set', entries: { API_KEY: 'topsecret' } }
				}) as never
			)
		);
		expect(res.ok).toBe(true);
		expect(JSON.stringify(res)).not.toContain('topsecret');
		const set = res.set as { id: string; keys: string[] };
		expect(set.keys).toEqual(['API_KEY']);

		const list = await json(await listSets(event({}) as never));
		expect(JSON.stringify(list)).not.toContain('topsecret');
	});

	it('reveals a value and audits the key name only', async () => {
		const created = await json(
			await createSet(
				event({
					method: 'POST',
					body: { name: 'audit-set', entries: { DEEP: 'verysecret' } }
				}) as never
			)
		);
		const id = (created.set as { id: string }).id;

		const revealed = await json(
			await revealKey(event({ method: 'POST', params: { id }, body: { key: 'DEEP' } }) as never)
		);
		expect(revealed.value).toBe('verysecret');

		const row = ref.db
			.prepare(
				"SELECT action, detail FROM audit_log WHERE action = 'secrets.reveal' ORDER BY id DESC LIMIT 1"
			)
			.get() as { action: string; detail: string };
		expect(row.action).toBe('secrets.reveal');
		expect(row.detail).toContain('DEEP');
		expect(row.detail).not.toContain('verysecret');
	});

	it('rejects hostile input and replaces entries via PUT', async () => {
		const created = await json(
			await createSet(
				event({ method: 'POST', body: { name: 'hostile', entries: { A: '1' } } }) as never
			)
		);
		const id = (created.set as { id: string }).id;

		expect(
			await status(createSet, event({ method: 'POST', body: { name: 'bad', entries: { NUM: 5 } } }))
		).toBe(422);
		expect(
			await status(revealKey, event({ method: 'POST', params: { id }, body: { key: 'not a key' } }))
		).toBe(422);
		expect(
			await status(revealKey, event({ method: 'POST', params: { id }, body: { key: 'MISSING' } }))
		).toBe(404);

		const replaced = await json(
			await putSet(event({ method: 'PUT', params: { id }, body: { entries: { B: '2' } } }) as never)
		);
		expect((replaced.set as { keys: string[] }).keys).toEqual(['B']);

		expect(await status(deleteSet, event({ method: 'DELETE', params: { id } }))).toBe(200);
		expect(await status(deleteSet, event({ method: 'DELETE', params: { id } }))).toBe(404);
	});
});
