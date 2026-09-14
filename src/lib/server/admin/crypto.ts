import {
	createHash,
	randomBytes,
	scryptSync,
	timingSafeEqual,
	createCipheriv,
	createDecipheriv
} from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { SCRYPT_N, SCRYPT_R, SCRYPT_P, TOKEN_BYTES } from '$lib/server/constants';
import { dataDir } from '$lib/server/store/db';

/** Unguessable URL-safe token for sessions, invites, reset links. */
export function randomToken(bytes = TOKEN_BYTES): string {
	return randomBytes(bytes).toString('base64url');
}

/** sha256 hex of a token; only hashes are stored server-side. */
export function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export function hashPassword(password: string): string {
	const salt = randomBytes(16);
	const key = scryptSync(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
	return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
	const parts = stored.split('$');
	if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
	const [, n, r, p, saltB64, hashB64] = parts;
	try {
		const salt = Buffer.from(saltB64, 'base64url');
		const expected = Buffer.from(hashB64, 'base64url');
		const actual = scryptSync(password, salt, expected.length, {
			N: Number(n),
			r: Number(r),
			p: Number(p)
		});
		return timingSafeEqual(actual, expected);
	} catch {
		return false;
	}
}

// Used to equalize timing when the account does not exist, so login
// responses do not reveal which usernames are registered.
let dummyHash: string | null = null;
export function verifyAgainstDummy(password: string): void {
	dummyHash ??= hashPassword(randomToken(8));
	verifyPassword(password, dummyHash);
}

/**
 * Symmetric key for encrypting small secrets at rest (TOTP seeds).
 * Prefers WHARFINGER_SECRET_KEY; otherwise generates a persistent random
 * key file in the data dir with owner-only permissions.
 */
function dataKey(): Buffer {
	const env = process.env.WHARFINGER_SECRET_KEY;
	if (env && env.length >= 16) return createHash('sha256').update(env).digest();
	mkdirSync(dataDir(), { recursive: true });
	const path = join(dataDir(), 'secrets.key');
	let raw: Buffer;
	try {
		raw = readFileSync(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		try {
			// wx is O_EXCL: atomic create-or-fail, no symlink following,
			// so a racing writer can never redirect or clobber the key.
			writeFileSync(path, randomBytes(32).toString('base64url'), {
				mode: 0o600,
				flag: 'wx'
			});
		} catch (werr) {
			if ((werr as NodeJS.ErrnoException).code !== 'EEXIST') throw werr;
		}
		try {
			chmodSync(path, 0o600);
		} catch {
			// best effort on filesystems without posix modes
		}
		raw = readFileSync(path);
	}
	return createHash('sha256').update(raw).digest();
}

/** AES-256-GCM sealed secret, encoded v1.<iv>.<tag>.<ct> base64url. */
export function sealSecret(plaintext: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', dataKey(), iv);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
}

export function openSecret(sealed: string): string | null {
	const parts = sealed.split('.');
	if (parts.length !== 4 || parts[0] !== 'v1') return null;
	try {
		const [, ivB, tagB, ctB] = parts;
		const decipher = createDecipheriv('aes-256-gcm', dataKey(), Buffer.from(ivB, 'base64url'));
		decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
		return Buffer.concat([
			decipher.update(Buffer.from(ctB, 'base64url')),
			decipher.final()
		]).toString('utf8');
	} catch {
		return null;
	}
}

// Passphrase-sealed payloads for portable backups. Unlike sealSecret
// the key derives from a caller passphrase via scrypt, not the machine
// secrets.key, so the envelope decrypts on any install.
export interface PassphraseEnvelope {
	v: 1;
	kdf: 'scrypt';
	N: number;
	r: number;
	p: number;
	salt: string;
	iv: string;
	tag: string;
	ct: string;
}

// Bounds on kdf params read from an untrusted envelope: a crafted file
// must not be able to request unbounded scrypt work on import.
const SCRYPT_MAX_N = 1 << 20;
const SCRYPT_MAX_RP = 64;

export function isPassphraseEnvelope(v: unknown): v is PassphraseEnvelope {
	if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
	const e = v as Record<string, unknown>;
	return (
		e.v === 1 &&
		e.kdf === 'scrypt' &&
		typeof e.N === 'number' &&
		typeof e.r === 'number' &&
		typeof e.p === 'number' &&
		typeof e.salt === 'string' &&
		typeof e.iv === 'string' &&
		typeof e.tag === 'string' &&
		typeof e.ct === 'string'
	);
}

export function sealWithPassphrase(plaintext: string, passphrase: string): PassphraseEnvelope {
	const salt = randomBytes(16);
	const key = scryptSync(passphrase, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return {
		v: 1,
		kdf: 'scrypt',
		N: SCRYPT_N,
		r: SCRYPT_R,
		p: SCRYPT_P,
		salt: salt.toString('base64url'),
		iv: iv.toString('base64url'),
		tag: cipher.getAuthTag().toString('base64url'),
		ct: ct.toString('base64url')
	};
}

export function openWithPassphrase(envelope: unknown, passphrase: string): string | null {
	if (!isPassphraseEnvelope(envelope)) return null;
	const { N, r, p } = envelope;
	// scrypt requires N > 1 and a power of two.
	if (
		!Number.isInteger(N) ||
		N < 2 ||
		N > SCRYPT_MAX_N ||
		(N & (N - 1)) !== 0 ||
		!Number.isInteger(r) ||
		r < 1 ||
		r > SCRYPT_MAX_RP ||
		!Number.isInteger(p) ||
		p < 1 ||
		p > SCRYPT_MAX_RP
	) {
		return null;
	}
	try {
		const salt = Buffer.from(envelope.salt, 'base64url');
		const iv = Buffer.from(envelope.iv, 'base64url');
		const tag = Buffer.from(envelope.tag, 'base64url');
		if (salt.length < 8 || iv.length !== 12 || tag.length !== 16) return null;
		const key = scryptSync(passphrase, salt, 32, { N, r, p });
		const decipher = createDecipheriv('aes-256-gcm', key, iv);
		decipher.setAuthTag(tag);
		return Buffer.concat([
			decipher.update(Buffer.from(envelope.ct, 'base64url')),
			decipher.final()
		]).toString('utf8');
	} catch {
		return null;
	}
}
