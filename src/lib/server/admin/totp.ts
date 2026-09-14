import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TOTP_STEP_SECONDS, TOTP_WINDOW } from '$lib/server/constants';

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of buf) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
	return out;
}

export function base32Decode(str: string): Buffer | null {
	const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const ch of clean) {
		const idx = B32_ALPHABET.indexOf(ch);
		if (idx === -1) return null;
		value = (value << 5) | idx;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

/** New 160-bit TOTP seed, base32 (otpauth-friendly). */
export function generateTotpSecret(): string {
	return base32Encode(randomBytes(20));
}

function hotp(secret: Buffer, counter: number): string {
	const msg = Buffer.alloc(8);
	msg.writeBigUInt64BE(BigInt(counter));
	const digest = createHmac('sha1', secret).update(msg).digest();
	const offset = digest[digest.length - 1] & 0x0f;
	const code =
		((digest[offset] & 0x7f) << 24) |
		(digest[offset + 1] << 16) |
		(digest[offset + 2] << 8) |
		digest[offset + 3];
	return String(code % 1_000_000).padStart(6, '0');
}

export function totpCode(secretB32: string, atMs = Date.now()): string | null {
	const secret = base32Decode(secretB32);
	if (!secret || secret.length === 0) return null;
	return hotp(secret, Math.floor(atMs / 1000 / TOTP_STEP_SECONDS));
}

/** Verify a 6-digit code within +/- TOTP_WINDOW steps. Constant-time-ish. */
export function verifyTotp(secretB32: string, code: string, atMs = Date.now()): boolean {
	const secret = base32Decode(secretB32);
	if (!secret || secret.length === 0 || !/^\d{6}$/.test(code)) return false;
	const counter = Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
	for (let w = -TOTP_WINDOW; w <= TOTP_WINDOW; w++) {
		const expected = hotp(secret, counter + w);
		if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return true;
	}
	return false;
}

export function totpUri(secretB32: string, account: string, issuer: string): string {
	const enc = encodeURIComponent;
	return `otpauth://totp/${enc(issuer)}:${enc(account)}?secret=${secretB32}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_SECONDS}`;
}
