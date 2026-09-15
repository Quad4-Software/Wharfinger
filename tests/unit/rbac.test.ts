import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '$lib/server/store/db';
import { UserStore, type User } from '$lib/server/admin/users';
import { RoleStore } from '$lib/server/admin/roles';
import { InviteStore } from '$lib/server/admin/invites';
import { ALL_PERMISSIONS, can } from '$lib/server/admin/authz';

process.env.WHARFINGER_SECRET_KEY = 'unit-test-secret-key-material';

function fresh(): {
	db: DatabaseSync;
	users: UserStore;
	roles: RoleStore;
	invites: InviteStore;
} {
	const db = openDb(mkdtempSync(join(tmpdir(), 'wharfinger-rbac-')));
	const users = new UserStore(db);
	return {
		db,
		users,
		roles: new RoleStore(db, users),
		invites: new InviteStore(db)
	};
}

function asRole(role: string): User {
	return {
		id: 1,
		username: 'u',
		displayName: '',
		role,
		totpEnabled: false,
		createdAt: 0,
		disabledAt: null,
		lastLoginAt: null
	};
}

describe('RoleStore seeding', () => {
	it('seeds the three builtin roles exactly once', async () => {
		const { db, users, roles } = fresh();
		const names = (await roles.list()).map((r) => r.name);
		expect(names).toEqual(['admin', 'operator', 'viewer']);
		expect((await roles.list()).every((r) => r.builtin)).toBe(true);
		// Reconstruction must not duplicate or overwrite rows.
		const again = new RoleStore(db, users);
		expect(await again.list()).toHaveLength(3);
		expect((await roles.get('operator'))?.permissions).toEqual([
			'status.view',
			'status.manage',
			'notifications.test',
			'deploy.view',
			'scan.view',
			'anomaly.view',
			'groups.manage',
			'secrets.manage'
		]);
		expect((await roles.get('viewer'))?.permissions).toEqual([
			'status.view',
			'scan.view',
			'anomaly.view'
		]);
	});

	it('upgrades a pristine legacy builtin row but keeps admin edits', async () => {
		const { db, users, roles: first } = fresh();
		// Seeding is lazy now, so force it before editing the raw rows.
		await first.list();
		// Simulate a row seeded before the new permissions existed.
		db.prepare("UPDATE roles SET permissions = ? WHERE name = 'operator'").run(
			JSON.stringify(['status.view', 'status.manage', 'notifications.test', 'deploy.view'])
		);
		// A customized builtin must not be touched by the upgrade.
		db.prepare("UPDATE roles SET permissions = ? WHERE name = 'viewer'").run(
			JSON.stringify(['status.view', 'audit.view'])
		);
		const roles = new RoleStore(db, users);
		expect((await roles.permsFor('operator')).has('groups.manage')).toBe(true);
		expect((await roles.permsFor('viewer')).has('audit.view')).toBe(true);
		expect((await roles.permsFor('viewer')).has('scan.view')).toBe(false);
	});
});

describe('admin lockout-proofing', () => {
	it('grants every permission regardless of the stored row', async () => {
		const { db, roles } = fresh();
		const admin = asRole('admin');
		for (const p of ALL_PERMISSIONS) {
			expect(await can(roles, admin, p)).toBe(true);
		}
		// Even a corrupted stored row cannot strip admin.
		db.prepare("UPDATE roles SET permissions = '[]' WHERE name = 'admin'").run();
		for (const p of ALL_PERMISSIONS) {
			expect((await roles.permsFor('admin')).has(p)).toBe(true);
		}
	});

	it('rejects update and remove on admin', async () => {
		const { roles } = fresh();
		expect(await roles.update('admin', 'X', ['status.view'])).toBe('protected');
		expect(await roles.remove('admin')).toBe('protected');
	});
});

describe('custom role CRUD', () => {
	it('creates, reads, updates, and removes a role', async () => {
		const { roles } = fresh();
		const r = await roles.create('oncall', 'On Call', ['status.view', 'notifications.test']);
		expect(r.builtin).toBe(false);
		expect(await roles.exists('oncall')).toBe(true);
		expect((await roles.get('oncall'))?.label).toBe('On Call');
		expect((await roles.permsFor('oncall')).has('status.view')).toBe(true);
		expect((await roles.permsFor('oncall')).has('status.manage')).toBe(false);

		expect(await roles.update('oncall', 'On-Call', ['status.view', 'status.manage'])).toBe('ok');
		expect((await roles.get('oncall'))?.label).toBe('On-Call');
		expect((await roles.permsFor('oncall')).has('status.manage')).toBe(true);

		expect(await roles.remove('oncall')).toBe('ok');
		expect(await roles.exists('oncall')).toBe(false);
	});

	it('perm resolution follows edits immediately', async () => {
		const { roles } = fresh();
		await roles.create('oncall', 'On Call', ['status.view']);
		const u = asRole('oncall');
		expect(await can(roles, u, 'status.view')).toBe(true);
		expect(await can(roles, u, 'status.manage')).toBe(false);
		await roles.update('oncall', 'On Call', ['status.view', 'status.manage']);
		expect(await can(roles, u, 'status.manage')).toBe(true);
	});

	it('reports missing for updates on unknown roles', async () => {
		const { roles } = fresh();
		expect(await roles.update('ghost', 'X', [])).toBe('missing');
		expect(await roles.remove('ghost')).toBe('missing');
	});
});

describe('delete guards', () => {
	it('refuses to delete a role still assigned to users', async () => {
		const { users, roles } = fresh();
		await roles.create('oncall', 'On Call', ['status.view']);
		const u = await users.create('eve', 'a-very-long-password', 'oncall');
		expect(await users.countByRole('oncall')).toBe(1);
		expect(await roles.remove('oncall')).toBe('in_use');
		await users.remove(u.id);
		expect(await roles.remove('oncall')).toBe('ok');
	});

	it('refuses to delete builtin roles', async () => {
		const { roles } = fresh();
		expect(await roles.remove('operator')).toBe('protected');
		expect(await roles.remove('viewer')).toBe('protected');
	});
});

describe('unknown roles', () => {
	it('resolve to an empty permission set', async () => {
		const { roles } = fresh();
		expect((await roles.permsFor('ghost')).size).toBe(0);
		expect(await can(roles, asRole('ghost'), 'status.view')).toBe(false);
	});
});

describe('invite role validation', () => {
	it('invites resolve against the roles table', async () => {
		const { roles, invites } = fresh();
		const { invite } = await invites.create({ kind: 'invite', role: 'oncall', ttlMs: 60_000 });
		expect(await roles.exists(invite.role)).toBe(false);
		await roles.create('oncall', 'On Call', ['status.view']);
		expect(await roles.exists(invite.role)).toBe(true);
	});
});
