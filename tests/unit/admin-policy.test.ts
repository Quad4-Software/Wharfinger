import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { USERNAME_RE, checkPassword } from '$lib/server/admin/policy';
import { can, sectionPermission, sectionReadPermission } from '$lib/server/admin/authz';
import { UserStore, type User } from '$lib/server/admin/users';
import { RoleStore } from '$lib/server/admin/roles';
import { openDb } from '$lib/server/store/db';
import { SECTION_KEYS } from '$lib/server/config/schema';

const db = openDb(mkdtempSync(join(tmpdir(), 'wharfinger-policy-')));
const roles = new RoleStore(db, new UserStore(db));

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
const operator: User = { ...admin, id: 2, username: 'ops', role: 'operator' };

describe('USERNAME_RE', () => {
	it('accepts normal usernames', () => {
		for (const u of ['ab', 'a-b_c.d', 'alice2', 'x' + 'y'.repeat(62)]) {
			expect(USERNAME_RE.test(u)).toBe(true);
		}
	});

	it('rejects bad usernames', () => {
		for (const u of ['a', 'Alic e', '-lead', '_lead', 'with space', 'üser', 'a'.repeat(65), '']) {
			expect(USERNAME_RE.test(u)).toBe(false);
		}
	});
});

describe('checkPassword', () => {
	it('enforces minimum length', () => {
		expect(checkPassword('short', 'alice', 12)).toContain('at least 12');
		expect(checkPassword('long-enough-password', 'alice', 12)).toBeNull();
	});

	it('rejects passwords containing the username', () => {
		expect(checkPassword('Alice-is-the-best-1', 'alice', 12)).toContain('username');
	});

	it('rejects absurd lengths', () => {
		expect(checkPassword('x'.repeat(300), 'alice', 12)).toContain('too long');
	});
});

describe('can', () => {
	it('grants admins every permission', () => {
		for (const p of [
			'status.view',
			'status.manage',
			'notifications.test',
			'admin.settings',
			'users.manage',
			'invites.manage',
			'roles.manage',
			'audit.view',
			'config.raw'
		] as const) {
			expect(can(roles, admin, p)).toBe(true);
		}
	});

	it('limits operators to day-to-day status work', () => {
		expect(can(roles, operator, 'status.view')).toBe(true);
		expect(can(roles, operator, 'status.manage')).toBe(true);
		expect(can(roles, operator, 'notifications.test')).toBe(true);
		for (const p of [
			'admin.settings',
			'users.manage',
			'invites.manage',
			'roles.manage',
			'audit.view',
			'config.raw'
		] as const) {
			expect(can(roles, operator, p)).toBe(false);
		}
	});
});

describe('sectionPermission', () => {
	it('requires admin.settings for auth and admin-facing sections only', () => {
		const adminOnly = new Set(['admin', 'oidc', 'ldap', 'telemetry', 'ingress']);
		for (const s of SECTION_KEYS) {
			expect(sectionPermission(s)).toBe(adminOnly.has(s) ? 'admin.settings' : 'status.manage');
			// Sections can carry secrets, so reads sit at the write tier.
			expect(sectionReadPermission(s)).toBe(adminOnly.has(s) ? 'admin.settings' : 'status.manage');
		}
	});
});
