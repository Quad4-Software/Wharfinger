import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { openDb } from '$lib/server/store/db';
import { UserStore } from '$lib/server/admin/users';
import { clientDataChallenge, relyingParty, WebAuthnStore } from '$lib/server/admin/webauthn';
import { hashToken, randomToken } from '$lib/server/admin/crypto';
import type { StatusConfig } from '$lib/server/config/schema';

function freshDb(): DatabaseSync {
	return openDb(mkdtempSync(join(tmpdir(), 'wharfinger-testdb-')));
}

function setup(): { db: DatabaseSync; users: UserStore; passkeys: WebAuthnStore; userId: number } {
	const db = freshDb();
	const users = new UserStore(db);
	const passkeys = new WebAuthnStore(db);
	const userId = users.create('alice', 'a-very-long-password', 'admin').id;
	return { db, users, passkeys, userId };
}

function insertCred(passkeys: WebAuthnStore, userId: number, credId = 'cred-1') {
	return passkeys.insert({
		userId,
		credentialId: credId,
		publicKey: new Uint8Array([1, 2, 3, 4]),
		counter: 0,
		transports: ['usb', 'nfc'],
		name: 'YubiKey 5',
		backedUp: false
	});
}

describe('webauthn challenges', () => {
	it('issues a challenge stored only as a hash', () => {
		const { db, passkeys, userId } = setup();
		const token = randomToken();
		passkeys.putChallenge(token, 'register', userId, 60_000);
		const row = db.prepare('SELECT token_hash FROM webauthn_challenges').get() as {
			token_hash: string;
		};
		expect(row.token_hash).toBe(hashToken(token));
		expect(row.token_hash).not.toBe(token);
	});

	it('peek finds a live challenge without consuming it', () => {
		const { passkeys, userId } = setup();
		const token = randomToken();
		passkeys.putChallenge(token, 'register', userId, 60_000);
		expect(passkeys.peekChallenge(token, 'register')?.userId).toBe(userId);
		expect(passkeys.peekChallenge(token, 'register')?.userId).toBe(userId);
	});

	it('consume is single-use and returns the bound user', () => {
		const { passkeys, userId } = setup();
		const token = randomToken();
		passkeys.putChallenge(token, 'login', userId, 60_000);
		expect(passkeys.consumeChallenge(token, 'login')?.userId).toBe(userId);
		expect(passkeys.consumeChallenge(token, 'login')).toBeNull();
		expect(passkeys.peekChallenge(token, 'login')).toBeNull();
	});

	it('kinds do not cross-consume', () => {
		const { passkeys, userId } = setup();
		const token = randomToken();
		passkeys.putChallenge(token, 'register', userId, 60_000);
		expect(passkeys.consumeChallenge(token, 'login')).toBeNull();
		expect(passkeys.consumeChallenge(token, 'register')?.userId).toBe(userId);
	});

	it('supports discoverable challenges with no bound user', () => {
		const { passkeys } = setup();
		const token = randomToken();
		passkeys.putChallenge(token, 'login', null, 60_000);
		const pending = passkeys.peekChallenge(token, 'login');
		expect(pending?.userId).toBeNull();
	});

	it('rejects expired challenges on peek, consume, and prune', () => {
		const { passkeys, userId } = setup();
		const now = Date.now();
		const token = randomToken();
		passkeys.putChallenge(token, 'login', userId, 1000, now);
		expect(passkeys.peekChallenge(token, 'login', now + 2000)).toBeNull();
		expect(passkeys.consumeChallenge(token, 'login', now + 2000)).toBeNull();
		expect(passkeys.prune(now + 2000)).toBe(1);
	});

	it('rejects unknown tokens', () => {
		const { passkeys } = setup();
		expect(passkeys.peekChallenge('nope', 'login')).toBeNull();
		expect(passkeys.consumeChallenge('nope', 'login')).toBeNull();
	});
});

describe('webauthn credentials', () => {
	it('inserts, lists, and looks up credentials', () => {
		const { passkeys, userId } = setup();
		insertCred(passkeys, userId);
		const cred = passkeys.byCredentialId('cred-1');
		expect(cred?.userId).toBe(userId);
		expect(cred?.transports).toEqual(['usb', 'nfc']);
		expect(cred?.name).toBe('YubiKey 5');
		expect(cred?.backedUp).toBe(false);
		expect(passkeys.forUser(userId)).toHaveLength(1);
	});

	it('refuses a duplicate credential id', () => {
		const { passkeys, users, userId } = setup();
		const other = users.create('bob', 'a-very-long-password', 'admin').id;
		insertCred(passkeys, userId);
		expect(insertCred(passkeys, other)).toBeNull();
		expect(passkeys.forUser(other)).toHaveLength(0);
	});

	it('renames and removes only owner-scoped rows', () => {
		const { passkeys, users, userId } = setup();
		const other = users.create('bob', 'a-very-long-password', 'admin').id;
		const cred = insertCred(passkeys, userId);
		expect(cred).not.toBeNull();
		expect(passkeys.rename(cred?.id ?? 0, other, 'hijack')).toBe(false);
		expect(passkeys.rename(cred?.id ?? 0, userId, 'MacBook')).toBe(true);
		expect(passkeys.byCredentialId('cred-1')?.name).toBe('MacBook');
		expect(passkeys.remove(cred?.id ?? 0, other)).toBeNull();
		expect(passkeys.remove(cred?.id ?? 0, userId)?.credentialId).toBe('cred-1');
		expect(passkeys.byCredentialId('cred-1')).toBeNull();
	});

	it('cascades credential and challenge rows when the user is deleted', () => {
		const { db, users, passkeys, userId } = setup();
		insertCred(passkeys, userId);
		passkeys.putChallenge(randomToken(), 'register', userId, 60_000);
		users.remove(userId);
		const creds = db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials').get() as {
			n: number;
		};
		const challenges = db.prepare('SELECT COUNT(*) AS n FROM webauthn_challenges').get() as {
			n: number;
		};
		expect(creds.n).toBe(0);
		expect(challenges.n).toBe(0);
	});

	it('survives malformed transports json', () => {
		const { db, passkeys, userId } = setup();
		const cred = insertCred(passkeys, userId);
		db.prepare('UPDATE webauthn_credentials SET transports = ? WHERE id = ?').run(
			'not json',
			cred?.id ?? 0
		);
		expect(passkeys.byCredentialId('cred-1')?.transports).toEqual([]);
	});
});

describe('sign counter', () => {
	it('accepts a first nonzero counter and stamps last_used', () => {
		const { passkeys, userId } = setup();
		const cred = insertCred(passkeys, userId);
		expect(passkeys.recordUse(cred?.id ?? 0, 5, true, 1000)).toBe('ok');
		const after = passkeys.byCredentialId('cred-1');
		expect(after?.counter).toBe(5);
		expect(after?.lastUsedAt).toBe(1000);
		expect(after?.backedUp).toBe(true);
	});

	it('accepts an advancing counter', () => {
		const { passkeys, userId } = setup();
		const cred = insertCred(passkeys, userId);
		passkeys.recordUse(cred?.id ?? 0, 5, false);
		expect(passkeys.recordUse(cred?.id ?? 0, 6, false)).toBe('ok');
		expect(passkeys.byCredentialId('cred-1')?.counter).toBe(6);
	});

	it('rejects and deletes the credential on counter regression', () => {
		const { passkeys, userId } = setup();
		const cred = insertCred(passkeys, userId);
		passkeys.recordUse(cred?.id ?? 0, 5, false);
		expect(passkeys.recordUse(cred?.id ?? 0, 5, false)).toBe('cloned');
		expect(passkeys.byCredentialId('cred-1')).toBeNull();
	});

	it('rejects a backwards jump too', () => {
		const { passkeys, userId } = setup();
		const cred = insertCred(passkeys, userId);
		passkeys.recordUse(cred?.id ?? 0, 10, false);
		expect(passkeys.recordUse(cred?.id ?? 0, 3, false)).toBe('cloned');
	});

	it('ignores authenticators that never report a counter', () => {
		const { passkeys, userId } = setup();
		const cred = insertCred(passkeys, userId);
		expect(passkeys.recordUse(cred?.id ?? 0, 0, false)).toBe('ok');
		expect(passkeys.recordUse(cred?.id ?? 0, 0, false)).toBe('ok');
		expect(passkeys.byCredentialId('cred-1')?.counter).toBe(0);
	});

	it('does not flag a stored nonzero counter when the new one is zero', () => {
		const { passkeys, userId } = setup();
		const cred = insertCred(passkeys, userId);
		passkeys.recordUse(cred?.id ?? 0, 7, false);
		expect(passkeys.recordUse(cred?.id ?? 0, 0, false)).toBe('ok');
		expect(passkeys.byCredentialId('cred-1')?.counter).toBe(7);
	});

	it('reports missing credentials', () => {
		const { passkeys } = setup();
		expect(passkeys.recordUse(999, 1, false)).toBe('missing');
	});
});

describe('clientDataChallenge', () => {
	function clientData(challenge: string): string {
		return isoBase64URL.fromUTF8String(
			JSON.stringify({ type: 'webauthn.get', challenge, origin: 'https://status.example' })
		);
	}

	it('extracts the signed challenge', () => {
		expect(clientDataChallenge(clientData('abc123_-xyz'))).toBe('abc123_-xyz');
	});

	it('rejects non-strings, garbage, and missing challenges', () => {
		expect(clientDataChallenge(undefined)).toBeNull();
		expect(clientDataChallenge(42)).toBeNull();
		expect(clientDataChallenge('!!!not-base64!!!')).toBeNull();
		expect(clientDataChallenge(isoBase64URL.fromUTF8String('{"type":"webauthn.get"}'))).toBeNull();
		expect(clientDataChallenge(isoBase64URL.fromUTF8String('not json at all'))).toBeNull();
	});
});

describe('relyingParty', () => {
	const base = { site: { name: 'Quad4' }, admin: {} } as unknown as StatusConfig;

	it('derives rpID and origin from the request url', () => {
		const rp = relyingParty(base, new URL('https://status.example.com/admin/login'));
		expect(rp.rpID).toBe('status.example.com');
		expect(rp.origin).toBe('https://status.example.com');
		expect(rp.rpName).toBe('Quad4');
	});

	it('honors config overrides', () => {
		const cfg = {
			site: { name: 'Quad4' },
			admin: { webauthn_rp_id: 'example.com', webauthn_origin: 'https://panel.example.com' }
		} as unknown as StatusConfig;
		const rp = relyingParty(cfg, new URL('https://status.example.com/admin/login'));
		expect(rp.rpID).toBe('example.com');
		expect(rp.origin).toBe('https://panel.example.com');
	});
});
