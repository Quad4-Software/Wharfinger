import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

// Agent proof-of-possession helpers. Agents carry an ed25519 identity
// key generated on first run; the public half is TOFU-bound to the
// agents row (agents.pubkey, base64 raw 32 bytes). Two proofs exist:
// the hello proof signs the per-connection nonce issued by
// /ingress/handshake, and the per-request proof signs the exact body
// bytes of a metrics post.

/** Decode a base64 raw 32-byte ed25519 public key, or null. */
export function decodePubkey(b64: unknown): Buffer | null {
	if (typeof b64 !== 'string' || b64.length === 0 || b64.length > 128) return null;
	const raw = Buffer.from(b64, 'base64');
	if (raw.length !== 32) return null;
	// Reject non-canonical encodings so the stored string compares
	// byte-for-byte with what the agent sends.
	if (raw.toString('base64') !== b64) return null;
	return raw;
}

/** Verify an ed25519 signature (base64) over msg against a raw key. */
export function verifyAgentSig(pubRaw: Buffer, msg: Buffer, sigB64: unknown): boolean {
	if (typeof sigB64 !== 'string' || sigB64.length === 0 || sigB64.length > 256) return false;
	try {
		const key = createPublicKey({
			key: { kty: 'OKP', crv: 'Ed25519', x: pubRaw.toString('base64url') },
			format: 'jwk'
		});
		return cryptoVerify(null, msg, key, Buffer.from(sigB64, 'base64'));
	} catch {
		return false;
	}
}
