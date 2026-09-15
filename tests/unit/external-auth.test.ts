import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '$lib/server/store/db';
import { UserStore } from '$lib/server/admin/users';
import { resolveExternalUser, roleFromGroups } from '$lib/server/admin/external';
import { mapClaims } from '$lib/server/admin/oidc';
import { verifyPassword } from '$lib/server/admin/crypto';
import type { StatusConfig } from '$lib/server/config/schema';

function freshUsers(): UserStore {
	return new UserStore(openDb(mkdtempSync(join(tmpdir(), 'wharfinger-ext-'))));
}

const GROUP_CFG = {
	admin_group: 'status-admins',
	operator_group: 'status-viewers',
	default_role: 'deny' as const
};

describe('roleFromGroups', () => {
	it('maps group membership to roles with precedence', () => {
		expect(roleFromGroups(['status-admins'], GROUP_CFG)).toBe('admin');
		expect(roleFromGroups(['status-viewers'], GROUP_CFG)).toBe('operator');
		expect(roleFromGroups(['status-viewers', 'status-admins'], GROUP_CFG)).toBe('admin');
		expect(roleFromGroups(['STATUS-ADMINS'], GROUP_CFG)).toBe('admin');
		expect(roleFromGroups(['other'], GROUP_CFG)).toBeNull();
		expect(roleFromGroups([], GROUP_CFG)).toBeNull();
	});

	it('falls back to default_role when no group matches', () => {
		const cfg = { ...GROUP_CFG, default_role: 'operator' as const };
		expect(roleFromGroups(['other'], cfg)).toBe('operator');
	});
});

describe('resolveExternalUser', () => {
	it('provisions on first login and syncs on later ones', async () => {
		const users = freshUsers();
		const u1 = (await resolveExternalUser(
			users,
			'oidc',
			'iss|sub1',
			'alice',
			'Alice A',
			'operator',
			true
		))!;
		expect(u1.username).toBe('alice');
		expect(u1.role).toBe('operator');
		const u2 = (await resolveExternalUser(
			users,
			'oidc',
			'iss|sub1',
			'alice',
			'Alice B',
			'admin',
			true
		))!;
		expect(u2.id).toBe(u1.id);
		expect((await users.byId(u1.id))!.displayName).toBe('Alice B');
		expect((await users.byId(u1.id))!.role).toBe('admin');
	});

	it('never adopts a same-named local account', async () => {
		const users = freshUsers();
		const local = await users.create('admin', 'correct horse battery', 'admin');
		const ext = (await resolveExternalUser(
			users,
			'oidc',
			'iss|x',
			'admin',
			'Ad Min',
			'admin',
			true
		))!;
		expect(ext.id).not.toBe(local.id);
		expect(ext.username).not.toBe('admin');
		// Local login still works; external user has no password.
		expect(
			verifyPassword('correct horse battery', (await users.rowByName('admin'))!.password_hash)
		).toBe(true);
		expect(verifyPassword('anything', (await users.rowByName(ext.username))!.password_hash)).toBe(
			false
		);
	});

	it('returns null for disabled external accounts', async () => {
		const users = freshUsers();
		const u = (await resolveExternalUser(users, 'ldap', 'dn1', 'bob', 'Bob', 'operator', true))!;
		await users.setDisabled(u.id, true);
		expect(
			await resolveExternalUser(users, 'ldap', 'dn1', 'bob', 'Bob', 'operator', true)
		).toBeNull();
	});
});

describe('oidc mapClaims', () => {
	const cfg: StatusConfig['oidc'] = {
		enabled: true,
		issuer: 'https://auth.quad4.io',
		client_id: 'status',
		client_secret: '',
		scopes: 'openid profile email groups',
		button_label: 'SSO',
		username_claim: 'preferred_username',
		groups_claim: 'groups',
		admin_group: 'status-admins',
		operator_group: 'status-viewers',
		default_role: 'deny',
		sync_profile: true
	};

	it('maps claims with groups', () => {
		const ident = mapClaims(cfg, {
			sub: 'u123',
			preferred_username: 'alice',
			name: 'Alice',
			groups: ['status-admins']
		});
		expect(ident).toMatchObject({
			externalId: 'https://auth.quad4.io|u123',
			username: 'alice',
			displayName: 'Alice',
			role: 'admin'
		});
	});

	it('falls back to email/sub for username and denies without role', () => {
		const viaEmail = mapClaims(cfg, {
			sub: 's',
			email: 'bob@corp.io',
			groups: ['status-viewers']
		});
		expect(viaEmail?.username).toBe('bob');
		expect(mapClaims(cfg, { sub: 's', groups: [] })).toBeNull();
		expect(mapClaims(cfg, { groups: ['status-admins'] })).toBeNull();
	});
});
