import { describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { RequestEvent } from '@sveltejs/kit';
import type { Runtime } from '$lib/server/runtime';
import type { Permission } from '$lib/server/admin/authz';
import type { User } from '$lib/server/admin/users';
import { GroupError } from '$lib/server/groups/store';

// Fake a runtime backed by a real store on a temp db so both the store
// and the route handlers can be exercised against the same tables.
const ref = vi.hoisted(() => ({
	db: undefined as unknown as DatabaseSync,
	rt: undefined as unknown as Runtime,
	invalidations: 0
}));

vi.mock('$lib/server/runtime', async () => {
	process.env.WHARFINGER_SECRET_KEY = 'groups-test-key-material';
	const { mkdtempSync } = await import('node:fs');
	const { join } = await import('node:path');
	const { tmpdir } = await import('node:os');
	const dir = mkdtempSync(join(tmpdir(), 'q4s-groups-'));
	const { openDb } = await import('$lib/server/store/db');
	const { AuditStore } = await import('$lib/server/admin/audit');
	const db = openDb(dir);
	ref.db = db;
	ref.rt = {
		db,
		audit: new AuditStore(db),
		snapshot: {
			invalidate: () => {
				ref.invalidations += 1;
			}
		}
	} as unknown as Runtime;
	return { getRuntime: () => ref.rt };
});

const { getGroupStore } = await import('$lib/server/groups/store');
const { GET: listGroups, POST: createGroup } =
	await import('../../src/routes/admin/api/groups/+server');
const { PATCH: patchGroup, DELETE: deleteGroup } =
	await import('../../src/routes/admin/api/groups/[id]/+server');
const { PUT: putMembers } = await import('../../src/routes/admin/api/groups/[id]/members/+server');

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
	const path = opts.path ?? '/admin/api/groups';
	return {
		locals: {
			user: opts.user === undefined ? admin : opts.user,
			perms: new Set(opts.perms ?? ['groups.manage'])
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

function seedApp(id: string): void {
	ref.db
		.prepare(
			"INSERT INTO deploy_apps (id, name, agent_id, source, webhook_hash, created_at, updated_at) VALUES (?, ?, 'ag', '{}', ?, 0, 0)"
		)
		.run(id, `app-${id}`, `wh-${id}`);
}

describe('GroupStore', () => {
	it('creates, lists, updates, and removes groups', () => {
		const store = getGroupStore(ref.db);
		const g = store.create('Production', '#3b82f6');
		expect(g.id).toMatch(/^grp_/);
		expect(g.memberCount).toBe(0);

		expect(store.get(g.id)?.name).toBe('Production');
		expect(store.list().map((x) => x.name)).toContain('Production');

		const updated = store.update(g.id, { name: 'Prod', color: null });
		expect(updated?.name).toBe('Prod');
		expect(updated?.color).toBeNull();

		expect(store.remove(g.id)).toBe(true);
		expect(store.get(g.id)).toBeNull();
		expect(store.remove(g.id)).toBe(false);
	});

	it('rejects bad names and colors', () => {
		const store = getGroupStore(ref.db);
		expect(() => store.create('', null)).toThrow(GroupError);
		expect(() => store.create('x'.repeat(65), null)).toThrow(GroupError);
		expect(() => store.create('ok', 'red')).toThrow(GroupError);
		expect(() => store.create('ok', '#FFF')).toThrow(GroupError);
		try {
			store.create('', null);
		} catch (e) {
			expect((e as GroupError).status).toBe(422);
		}
	});

	it('dedupes members and removes them', () => {
		const store = getGroupStore(ref.db);
		const g = store.create('members-test', null);
		const svc = { memberKind: 'service' as const, memberId: 'web-1' };
		const once = store.setMembers(g.id, [svc], []);
		expect(once.memberCount).toBe(1);
		const twice = store.setMembers(g.id, [svc, svc], []);
		expect(twice.memberCount).toBe(1);
		const after = store.setMembers(g.id, [], [svc]);
		expect(after.memberCount).toBe(0);
	});

	it('validates member shape and app existence', () => {
		const store = getGroupStore(ref.db);
		const g = store.create('validate-test', null);
		seedApp('app_abc');
		expect(() =>
			store.setMembers(g.id, [{ memberKind: 'service', memberId: 'bad id!' }], [])
		).toThrow(GroupError);
		expect(() =>
			store.setMembers(g.id, [{ memberKind: 'app', memberId: 'app_missing' }], [])
		).toThrow(GroupError);
		const ok = store.setMembers(g.id, [{ memberKind: 'app', memberId: 'app_abc' }], []);
		expect(ok.memberCount).toBe(1);
	});

	it('cascades member rows on delete', () => {
		const store = getGroupStore(ref.db);
		const g = store.create('cascade-test', null);
		store.setMembers(g.id, [{ memberKind: 'service', memberId: 'web-2' }], []);
		store.remove(g.id);
		const n = ref.db
			.prepare('SELECT COUNT(*) AS n FROM service_group_members WHERE group_id = ?')
			.get(g.id) as { n: number };
		expect(n.n).toBe(0);
	});

	it('maps services to group ids for the snapshot', () => {
		const store = getGroupStore(ref.db);
		const a = store.create('idx-a', null);
		const b = store.create('idx-b', null);
		store.setMembers(a.id, [{ memberKind: 'service', memberId: 'svc-1' }], []);
		store.setMembers(b.id, [{ memberKind: 'service', memberId: 'svc-1' }], []);
		const idx = store.serviceGroupIndex();
		expect(idx.get('svc-1')?.sort()).toEqual([a.id, b.id].sort());
		expect(idx.has('svc-2')).toBe(false);
	});

	it('throws 404 when editing members of a missing group', () => {
		const store = getGroupStore(ref.db);
		try {
			store.setMembers('grp_none', [{ memberKind: 'service', memberId: 'x' }], []);
			expect.unreachable();
		} catch (e) {
			expect((e as GroupError).status).toBe(404);
		}
	});
});

describe('group routes', () => {
	it('rejects anonymous callers with 401', async () => {
		expect(await status(listGroups, event({ user: null }))).toBe(401);
	});

	it('rejects users without groups.manage with 403', async () => {
		expect(await status(listGroups, event({ perms: [] }))).toBe(403);
		expect(await status(listGroups, event({ perms: ['status.view'] }))).toBe(403);
	});

	it('creates a group and audits it', async () => {
		const res = await json(
			await createGroup(
				event({ method: 'POST', body: { name: 'api-group', color: '#a1b2c3' } }) as never
			)
		);
		expect(res.ok).toBe(true);
		const group = res.group as { id: string; name: string };
		expect(group.name).toBe('api-group');
		const row = ref.db
			.prepare(
				"SELECT action, detail FROM audit_log WHERE action = 'group.create' ORDER BY id DESC LIMIT 1"
			)
			.get() as { action: string; detail: string };
		expect(row.detail).toContain('api-group');
		expect(ref.invalidations).toBeGreaterThan(0);
	});

	it('rejects an invalid create body with 422', async () => {
		expect(
			await status(createGroup, event({ method: 'POST', body: { name: '', color: null } }))
		).toBe(422);
		expect(
			await status(createGroup, event({ method: 'POST', body: { name: 'x', color: 'blue' } }))
		).toBe(422);
	});

	it('patches, manages members, and deletes', async () => {
		const created = await json(
			await createGroup(event({ method: 'POST', body: { name: 'life' } }) as never)
		);
		const id = (created.group as { id: string }).id;

		const patched = await json(
			await patchGroup(
				event({ method: 'PATCH', params: { id }, body: { name: 'life-2' } }) as never
			)
		);
		expect((patched.group as { name: string }).name).toBe('life-2');

		const withMembers = await json(
			await putMembers(
				event({
					method: 'PUT',
					params: { id },
					body: { add: [{ memberKind: 'service', memberId: 'svc-9' }], remove: [] }
				}) as never
			)
		);
		expect((withMembers.group as { memberCount: number }).memberCount).toBe(1);

		expect(
			await status(
				putMembers,
				event({
					method: 'PUT',
					params: { id },
					body: { add: [{ memberKind: 'service', memberId: 'has space' }] }
				})
			)
		).toBe(422);

		expect(await status(deleteGroup, event({ method: 'DELETE', params: { id } }))).toBe(200);
		expect(await status(patchGroup, event({ method: 'PATCH', params: { id }, body: {} }))).toBe(
			404
		);
	});
});
