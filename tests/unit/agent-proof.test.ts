import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb } from '$lib/server/store/db';
import { AgentStore } from '$lib/server/ingress/agents';
import {
	hubSecret,
	publicKeyB64,
	publicKeyInfo,
	rotateHubKey,
	signToken
} from '$lib/server/ingress/keys';
import { decodePubkey, verifyAgentSig } from '$lib/server/ingress/proof';

function freshDb(): DatabaseSync {
	return openDb(mkdtempSync(join(tmpdir(), 'wharfinger-proof-')));
}

// Verify an ed25519 signature against a raw 32-byte pubkey by wrapping
// it in the fixed spki DER prefix.
function verifyRaw(pubB64: string, msg: Buffer, sigB64: string): boolean {
	const pub = Buffer.from(pubB64, 'base64');
	return verify(
		null,
		msg,
		{
			key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]),
			format: 'der',
			type: 'spki'
		},
		Buffer.from(sigB64, 'base64')
	);
}

describe('hub key rotation', () => {
	it('rotates with a proof the old key verifies', () => {
		const db = freshDb();
		const oldPub = publicKeyB64(db);
		const info = rotateHubKey(db);
		expect(info.pub).not.toBe(oldPub);
		expect(info.prev_pub).toBe(oldPub);
		expect(info.rotated_at).toBeTypeOf('number');
		// Proof covers the raw new pubkey bytes, signed by the OLD key.
		expect(verifyRaw(oldPub, Buffer.from(info.pub, 'base64'), info.proof!)).toBe(true);
		// The new key now signs handshake tokens.
		const sig = signToken(db, 'st_tok');
		expect(verifyRaw(info.pub, Buffer.from('st_tok'), sig)).toBe(true);
		// publicKeyInfo advertises the rotation fields.
		const adv = publicKeyInfo(db);
		expect(adv.pub).toBe(info.pub);
		expect(adv.prev_pub).toBe(oldPub);
		expect(adv.proof).toBe(info.proof);
	});

	it('chains proofs only one rotation deep', () => {
		const db = freshDb();
		const pubA = publicKeyB64(db);
		const infoB = rotateHubKey(db);
		const infoC = rotateHubKey(db);
		// Second proof is made by key B, not key A: an agent pinned to
		// A cannot verify and must re-pin manually.
		expect(infoC.prev_pub).toBe(infoB.pub);
		expect(verifyRaw(infoB.pub, Buffer.from(infoC.pub, 'base64'), infoC.proof!)).toBe(true);
		expect(verifyRaw(pubA, Buffer.from(infoC.pub, 'base64'), infoC.proof!)).toBe(false);
	});

	it('keeps the derivation secret stable across rotation', () => {
		const db = freshDb();
		const before = hubSecret(db);
		rotateHubKey(db);
		expect(hubSecret(db).equals(before)).toBe(true);
	});

	it('does not advertise proof fields before any rotation', () => {
		const db = freshDb();
		const info = publicKeyInfo(db);
		expect(info.pub).toBeTypeOf('string');
		expect(info.prev_pub).toBeUndefined();
		expect(info.proof).toBeUndefined();
	});
});

describe('agent pubkey binding', () => {
	it('binds the first key and rejects mismatches', () => {
		const store = new AgentStore(freshDb());
		const { id } = store.create('a', null);
		expect(store.checkPubkey(store.get(id)!, 'key_one')).toBe('bound');
		expect(store.checkPubkey(store.get(id)!, 'key_one')).toBe('ok');
		expect(store.checkPubkey(store.get(id)!, 'key_two')).toBe('mismatch');
	});

	it('stores and clears the bind nonce', () => {
		const store = new AgentStore(freshDb());
		const { id } = store.create('a', null);
		store.setBindNonce(id, 'nonce123');
		expect(store.get(id)!.bindNonce).toBe('nonce123');
		store.clearBindNonce(id);
		expect(store.get(id)!.bindNonce).toBeNull();
	});
});

describe('agent proof verification', () => {
	it('verifies a raw-key ed25519 signature', () => {
		const { privateKey, publicKey } = generateKeyPairSync('ed25519');
		const pubRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
		const msg = Buffer.from('nonce-bytes');
		const sig = sign(null, msg, privateKey).toString('base64');
		expect(verifyAgentSig(pubRaw, msg, sig)).toBe(true);
		expect(verifyAgentSig(pubRaw, Buffer.from('other'), sig)).toBe(false);
		expect(verifyAgentSig(pubRaw, msg, 'not-a-sig')).toBe(false);
		expect(verifyAgentSig(pubRaw, msg, null)).toBe(false);
	});

	it('accepts only canonical base64 32-byte keys', () => {
		const { publicKey } = generateKeyPairSync('ed25519');
		const pubRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
		expect(decodePubkey(pubRaw.toString('base64'))?.equals(pubRaw)).toBe(true);
		expect(decodePubkey(pubRaw.toString('base64') + ' ')).toBeNull();
		expect(decodePubkey('AAAA')).toBeNull();
		expect(decodePubkey(42)).toBeNull();
		expect(decodePubkey(null)).toBeNull();
	});
});
