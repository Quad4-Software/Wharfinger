import {
	createPrivateKey,
	generateKeyPairSync,
	randomBytes,
	sign,
	type KeyObject
} from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openSecret, sealSecret } from '../admin/crypto';

// Hub identity for the ws handshake. The private key signs each agent's
// registration token so the agent can verify it reached the real hub
// (the Beszel mutual-auth model). One row, pinned at id = 1. The DER
// blob is stored AES-GCM sealed like TOTP seeds so a db dump alone
// cannot forge push tokens or handshake signatures; rows written before
// sealing existed are migrated on first read.
//
// Rotation keeps continuity: prev_pub/rotated_at/proof record the last
// change, where proof is a signature BY THE OLD private key over the
// new raw pubkey bytes. Agents pinned to the old key verify the proof
// and adopt the new one. secret is a second sealed value that never
// rotates: it keys HMAC derivation (push tokens) so rotating the
// signing key does not invalidate push URLs. Pre-secret rows backfill
// it from the private key they already had, which keeps tokens minted
// before this column existed valid.

interface KeyRow {
	priv: string;
	pub: string;
	prev_pub: string | null;
	rotated_at: number | null;
	proof: string | null;
	secret: string | null;
}

interface HubKeys {
	priv: KeyObject;
	pubB64: string;
	prevPubB64: string | null;
	rotatedAt: number | null;
	proof: string | null;
	secret: Buffer;
}

// Keyed on the db handle: a different database (tests, recreated data
// dir) must never see another db's keypair.
const cache = new WeakMap<DatabaseSync, HubKeys>();

function create(db: DatabaseSync): HubKeys {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');
	// spki DER has a fixed 12-byte prefix; the raw 32-byte key follows.
	const pubRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
	const privDer = privateKey.export({ format: 'der', type: 'pkcs8' });
	// Two writers racing first boot: the insert is single-row guarded,
	// and whoever loses re-reads the winner's key below.
	db.prepare(
		'INSERT OR IGNORE INTO hub_keys (id, priv, pub, secret, created_at) VALUES (1, ?, ?, ?, ?)'
	).run(
		sealSecret(privDer.toString('base64')),
		pubRaw.toString('base64'),
		sealSecret(randomBytes(32).toString('hex')),
		Date.now()
	);
	const row = load(db);
	if (row) return row;
	return {
		priv: privateKey,
		pubB64: pubRaw.toString('base64'),
		prevPubB64: null,
		rotatedAt: null,
		proof: null,
		secret: randomBytes(32) // unreachable in practice; the row won
	};
}

function load(db: DatabaseSync): HubKeys | null {
	const row = db
		.prepare('SELECT priv, pub, prev_pub, rotated_at, proof, secret FROM hub_keys WHERE id = 1')
		.get() as KeyRow | undefined;
	if (!row) return null;
	let privB64: string | null;
	if (row.priv.startsWith('v1.')) {
		privB64 = openSecret(row.priv);
		if (privB64 === null) {
			// Sealed under a secrets.key that no longer exists: the old
			// key is unrecoverable, so replace the row outright. Push
			// URLs minted under it die either way.
			db.prepare('DELETE FROM hub_keys WHERE id = 1').run();
			return null;
		}
	} else {
		// Legacy plaintext row: use it, then reseal in place.
		privB64 = row.priv;
		try {
			db.prepare('UPDATE hub_keys SET priv = ? WHERE id = 1').run(sealSecret(privB64));
		} catch {
			// Reseal is best effort; the key still works unsealed.
		}
	}
	// The derivation secret must not change when the signing key
	// rotates. Rows predating the column adopt the private key they
	// already had so push tokens minted before the column existed
	// keep verifying.
	let secretB64 = row.secret;
	if (!secretB64) {
		secretB64 = sealSecret(Buffer.from(privB64, 'base64').toString('hex'));
		try {
			db.prepare('UPDATE hub_keys SET secret = ? WHERE id = 1').run(secretB64);
		} catch {
			// Best effort; the in-memory value is identical.
		}
	}
	const secretHex = openSecret(secretB64);
	const secret =
		secretHex !== null ? Buffer.from(secretHex, 'hex') : Buffer.from(privB64, 'base64');
	const priv = createPrivateKey({
		key: Buffer.from(privB64, 'base64'),
		format: 'der',
		type: 'pkcs8'
	});
	return {
		priv,
		pubB64: row.pub,
		prevPubB64: row.prev_pub,
		rotatedAt: row.rotated_at,
		proof: row.proof,
		secret
	};
}

function hubKeys(db: DatabaseSync): HubKeys {
	const hit = cache.get(db);
	if (hit) return hit;
	const keys = load(db) ?? create(db);
	cache.set(db, keys);
	return keys;
}

/** Raw secret bytes for keyed derivation (HMAC of push tokens). */
export function hubSecret(db: DatabaseSync): Buffer {
	return hubKeys(db).secret;
}

/** base64 ed25519 signature over the registration token. */
export function signToken(db: DatabaseSync, token: string): string {
	return sign(null, Buffer.from(token), hubKeys(db).priv).toString('base64');
}

export function publicKeyB64(db: DatabaseSync): string {
	return hubKeys(db).pubB64;
}

export interface HubKeyInfo {
	pub: string;
	prev_pub?: string;
	rotated_at?: number;
	proof?: string;
}

// Advertised key state for GET /ingress/pubkey. prev_pub and proof
// only appear after a rotation; proof signs the new raw pubkey bytes
// with the previous private key.
export function publicKeyInfo(db: DatabaseSync): HubKeyInfo {
	const k = hubKeys(db);
	const out: HubKeyInfo = { pub: k.pubB64 };
	if (k.prevPubB64 && k.rotatedAt !== null && k.proof) {
		out.prev_pub = k.prevPubB64;
		out.rotated_at = k.rotatedAt;
		out.proof = k.proof;
	}
	return out;
}

/**
 * Generate a new hub keypair and record the rotation. The proof lets
 * agents pinned to the previous key adopt the new one without trusting
 * the network; agents pinned to anything older (two rotations behind)
 * cannot verify and need a manual re-pin.
 */
export function rotateHubKey(db: DatabaseSync): HubKeyInfo {
	const cur = hubKeys(db);
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');
	const pubRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
	const privDer = privateKey.export({ format: 'der', type: 'pkcs8' });
	// Signed by the OLD key over the raw 32-byte new pubkey.
	const proof = sign(null, pubRaw, cur.priv).toString('base64');
	db.prepare(
		'UPDATE hub_keys SET priv = ?, pub = ?, prev_pub = ?, rotated_at = ?, proof = ? WHERE id = 1'
	).run(
		sealSecret(privDer.toString('base64')),
		pubRaw.toString('base64'),
		cur.pubB64,
		Date.now(),
		proof
	);
	cache.delete(db);
	return publicKeyInfo(db);
}
