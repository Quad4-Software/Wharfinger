import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '$lib/server/store/db';
import { UserStore } from '$lib/server/admin/users';
import { AuditStore } from '$lib/server/admin/audit';
import { adminEnvDisabled, bootstrapAdmin } from '$lib/server/admin/bootstrap';

process.env.WHARFINGER_SECRET_KEY = 'unit-test-secret-key-material';

function freshDb(): DatabaseSync {
	return openDb(mkdtempSync(join(tmpdir(), 'wharfinger-testdb-')));
}

function stores(): { users: UserStore; audit: AuditStore } {
	const db = freshDb();
	return { users: new UserStore(db), audit: new AuditStore(db) };
}

describe('adminEnvDisabled', () => {
	it('is unset by default', () => {
		expect(adminEnvDisabled({})).toBe(false);
	});

	it('treats common false-y spellings as disabled', () => {
		for (const v of ['0', 'false', 'FALSE', 'no', 'off', ' Off ']) {
			expect(adminEnvDisabled({ WHARFINGER_ADMIN_ENABLED: v })).toBe(true);
		}
	});

	it('ignores other values', () => {
		for (const v of ['1', 'true', 'yes', 'banana']) {
			expect(adminEnvDisabled({ WHARFINGER_ADMIN_ENABLED: v })).toBe(false);
		}
	});
});

describe('bootstrapAdmin', () => {
	it('creates the first admin from env credentials', async () => {
		const { users, audit } = stores();
		const r = await bootstrapAdmin(
			users,
			audit,
			{ WHARFINGER_ADMIN_USERNAME: 'root', WHARFINGER_ADMIN_PASSWORD: 'a-very-long-password' },
			12
		);
		expect(r).toBe('created');
		expect(await users.count()).toBe(1);
		expect((await users.byId(1))?.role).toBe('admin');
		expect((await users.byId(1))?.displayName).toBe('');
	});

	it('never overwrites an existing account', async () => {
		const { users, audit } = stores();
		await users.create('alice', 'a-very-long-password', 'operator');
		const r = await bootstrapAdmin(
			users,
			audit,
			{ WHARFINGER_ADMIN_USERNAME: 'root', WHARFINGER_ADMIN_PASSWORD: 'a-very-long-password' },
			12
		);
		expect(r).toBe('exists');
		expect(await users.count()).toBe(1);
		expect((await users.byId(1))?.role).toBe('operator');
	});

	it('reports unset when neither variable is present', async () => {
		const { users, audit } = stores();
		expect(await bootstrapAdmin(users, audit, {}, 12)).toBe('unset');
		expect(await users.count()).toBe(0);
	});

	it('reports incomplete when only one variable is present', async () => {
		const { users, audit } = stores();
		expect(await bootstrapAdmin(users, audit, { WHARFINGER_ADMIN_USERNAME: 'root' }, 12)).toBe(
			'incomplete'
		);
		expect(
			await bootstrapAdmin(users, audit, { WHARFINGER_ADMIN_PASSWORD: 'a-very-long-password' }, 12)
		).toBe('incomplete');
		expect(await users.count()).toBe(0);
	});

	it('rejects usernames that fail policy', async () => {
		const { users, audit } = stores();
		expect(
			await bootstrapAdmin(
				users,
				audit,
				{
					WHARFINGER_ADMIN_USERNAME: 'Root User!',
					WHARFINGER_ADMIN_PASSWORD: 'a-very-long-password'
				},
				12
			)
		).toBe('invalid');
		expect(await users.count()).toBe(0);
	});

	it('rejects passwords that fail policy', async () => {
		const { users, audit } = stores();
		expect(
			await bootstrapAdmin(
				users,
				audit,
				{ WHARFINGER_ADMIN_USERNAME: 'root', WHARFINGER_ADMIN_PASSWORD: 'short' },
				12
			)
		).toBe('invalid');
		// password containing the username is also rejected
		expect(
			await bootstrapAdmin(
				users,
				audit,
				{ WHARFINGER_ADMIN_USERNAME: 'root', WHARFINGER_ADMIN_PASSWORD: 'root-let-me-in-now' },
				12
			)
		).toBe('invalid');
		expect(await users.count()).toBe(0);
	});

	it('records the bootstrap in the audit log', async () => {
		const { users, audit } = stores();
		await bootstrapAdmin(
			users,
			audit,
			{ WHARFINGER_ADMIN_USERNAME: 'root', WHARFINGER_ADMIN_PASSWORD: 'a-very-long-password' },
			12
		);
		const { entries } = await audit.list({ limit: 10, offset: 0 });
		expect(entries.some((e) => e.action === 'admin.bootstrap')).toBe(true);
	});
});
