import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '$lib/server/store/db';
import { UserStore } from '$lib/server/admin/users';
import { InviteStore } from '$lib/server/admin/invites';
import { RoleStore } from '$lib/server/admin/roles';
import { canGrantRole, sectionPermission, sectionReadPermission } from '$lib/server/admin/authz';
import { ConfigStore } from '$lib/server/config/store';
import { resolveEffective } from '$lib/server/config/effective';
import { interpolateTrusted, ConfigError } from '$lib/server/config/load';
import { blockedIp } from '$lib/server/http/egress';
import { publicKeyB64, signToken } from '$lib/server/ingress/keys';
import { createPublicKey, generateKeyPairSync, verify, type KeyObject } from 'node:crypto';

process.env.WHARFINGER_SECRET_KEY = 'unit-test-secret-key-material';

function freshDb(): DatabaseSync {
	return openDb(mkdtempSync(join(tmpdir(), 'wharfinger-secdb-')));
}

const MINIMAL: Record<string, unknown> = {
	site: { name: 'Test Co' },
	services: [{ id: 'web', name: 'Web', type: 'http', url: 'https://example.com' }]
};

describe('InviteStore.tryClaim', () => {
	it('claims a usable invite exactly once', () => {
		const invites = new InviteStore(freshDb());
		const { invite } = invites.create({ kind: 'invite', role: 'operator', ttlMs: 60_000 });
		expect(invites.tryClaim(invite.tokenHash)).toBe(true);
		// Second claim on the same token loses the conditional update.
		expect(invites.tryClaim(invite.tokenHash)).toBe(false);
	});

	it('refuses expired and revoked invites', () => {
		const invites = new InviteStore(freshDb());
		const { invite } = invites.create({ kind: 'invite', role: 'operator', ttlMs: -1 });
		expect(invites.tryClaim(invite.tokenHash)).toBe(false);
		const b = invites.create({ kind: 'reset', role: 'operator', ttlMs: 60_000 }).invite;
		invites.revoke(b.tokenHash);
		expect(invites.tryClaim(b.tokenHash)).toBe(false);
	});
});

describe('UserStore.createFirstUser', () => {
	it('creates the first admin and rejects every later call', () => {
		const users = new UserStore(freshDb());
		const first = users.createFirstUser('alice', 'a-very-long-password', 'admin');
		expect(first?.role).toBe('admin');
		const second = users.createFirstUser('mallory', 'a-very-long-password', 'admin');
		expect(second).toBeNull();
		expect(users.count()).toBe(1);
	});
});

describe('canGrantRole', () => {
	it('only allows granting roles whose perms the actor holds', () => {
		const db = freshDb();
		const roles = new RoleStore(db, new UserStore(db));
		const admin = roles.permsFor('admin');
		const operator = roles.permsFor('operator');
		const viewer = roles.permsFor('viewer');

		expect(canGrantRole(roles, admin, 'admin')).toBe(true);
		expect(canGrantRole(roles, admin, 'viewer')).toBe(true);
		expect(canGrantRole(roles, operator, 'operator')).toBe(true);
		expect(canGrantRole(roles, operator, 'viewer')).toBe(true);
		expect(canGrantRole(roles, operator, 'admin')).toBe(false);
		expect(canGrantRole(roles, viewer, 'operator')).toBe(false);
		expect(canGrantRole(roles, null, 'viewer')).toBe(false);
		expect(canGrantRole(roles, admin, 'nonexistent')).toBe(false);
	});
});

describe('section permissions', () => {
	it('keeps secret-bearing sections at write tier for reads', () => {
		expect(sectionReadPermission('notifications')).toBe('status.manage');
		expect(sectionReadPermission('services')).toBe('status.manage');
		expect(sectionReadPermission('oidc')).toBe('admin.settings');
		expect(sectionPermission('oidc')).toBe('admin.settings');
	});
});

describe('env interpolation scoping', () => {
	it('interpolates file values but never override values', () => {
		process.env.QUAD4_TEST_VAR = 'resolved-secret';
		const fileRaw = {
			...MINIMAL,
			site: { name: '${QUAD4_TEST_VAR}' }
		};
		const store = new ConfigStore(freshDb());
		// A panel-written override containing ${VAR} stays literal.
		store.set('links', [{ label: '${QUAD4_TEST_VAR}', href: 'https://a.b' }], 'alice');
		const eff = resolveEffective(fileRaw, store);
		expect(eff.config.site.name).toBe('resolved-secret');
		expect(eff.config.links[0].label).toBe('${QUAD4_TEST_VAR}');
		// The raw merged doc still carries the placeholder for editing.
		expect((eff.raw.links as { label: string }[])[0].label).toBe('${QUAD4_TEST_VAR}');
	});

	it('fails on missing env vars referenced by the file only', () => {
		expect(() => interpolateTrusted({ a: '${QUAD4_NOPE_MISSING}' })).toThrow(ConfigError);
		// Overrides are not interpolated, so a missing ref there is inert.
		const store = new ConfigStore(freshDb());
		store.set('site', { name: '${QUAD4_NOPE_MISSING}' }, 'alice');
		const eff = resolveEffective(MINIMAL, store);
		expect(eff.config.site.name).toBe('${QUAD4_NOPE_MISSING}');
	});
});

describe('egress blockedIp', () => {
	it('blocks NAT64-embedded link-local addresses', () => {
		expect(blockedIp('64:ff9b::a9fe:a9fe')).toBe(true); // 169.254.169.254
		expect(blockedIp('64:ff9b::169.254.169.254')).toBe(true);
		expect(blockedIp('64:ff9b:1::a9fe:a9fe')).toBe(true);
		expect(blockedIp('64:ff9b::0808:0808')).toBe(false); // 8.8.8.8
		expect(blockedIp('::ffff:a9fe:a9fe')).toBe(true);
		expect(blockedIp('::ffff:8.8.8.8')).toBe(false);
	});
});

// Rebuild an spki KeyObject from the raw 32-byte ed25519 public key.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
function pubObj(rawB64: string): KeyObject {
	return createPublicKey({
		key: Buffer.concat([SPKI_PREFIX, Buffer.from(rawB64, 'base64')]),
		format: 'der',
		type: 'spki'
	});
}

describe('hub key sealing', () => {
	it('stores the private key sealed and still signs', () => {
		const db = freshDb();
		const pub = publicKeyB64(db);
		const sig = signToken(db, 'token-abc');
		const row = db.prepare('SELECT priv, pub FROM hub_keys WHERE id = 1').get() as {
			priv: string;
			pub: string;
		};
		expect(row.priv.startsWith('v1.')).toBe(true);
		expect(row.pub).toBe(pub);
		expect(verify(null, Buffer.from('token-abc'), pubObj(pub), Buffer.from(sig, 'base64'))).toBe(
			true
		);
	});

	it('migrates a legacy plaintext key row to sealed storage', () => {
		const db = freshDb();
		const { privateKey, publicKey } = generateKeyPairSync('ed25519');
		const privDer = privateKey.export({ format: 'der', type: 'pkcs8' });
		const pubRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
		db.prepare('INSERT INTO hub_keys (id, priv, pub, created_at) VALUES (1, ?, ?, ?)').run(
			privDer.toString('base64'),
			pubRaw.toString('base64'),
			Date.now()
		);
		const pub = publicKeyB64(db);
		expect(pub).toBe(pubRaw.toString('base64'));
		// The plaintext row was resealed in place on first read.
		const row = db.prepare('SELECT priv FROM hub_keys WHERE id = 1').get() as { priv: string };
		expect(row.priv.startsWith('v1.')).toBe(true);
		const sig = signToken(db, 't');
		expect(verify(null, Buffer.from('t'), pubObj(pub), Buffer.from(sig, 'base64'))).toBe(true);
	});
});
