import { describe, expect, it } from 'vitest';
import {
	hashPassword,
	hashToken,
	openSecret,
	randomToken,
	sealSecret,
	verifyPassword
} from '$lib/server/admin/crypto';

process.env.WHARFINGER_SECRET_KEY = 'unit-test-secret-key-material';

describe('password hashing', () => {
	it('round-trips a correct password', () => {
		const stored = hashPassword('correct horse battery staple');
		expect(stored.startsWith('scrypt$')).toBe(true);
		expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
	});

	it('rejects a wrong password', () => {
		const stored = hashPassword('correct horse battery staple');
		expect(verifyPassword('wrong', stored)).toBe(false);
	});

	it('uses a fresh salt per hash', () => {
		expect(hashPassword('same-password-123')).not.toBe(hashPassword('same-password-123'));
	});

	it('rejects malformed stored hashes', () => {
		expect(verifyPassword('x', 'not-a-hash')).toBe(false);
		expect(verifyPassword('x', 'scrypt$1$2$3$4')).toBe(false);
		expect(verifyPassword('x', 'bcrypt$16384$8$1$aaaa$bbbb')).toBe(false);
	});
});

describe('tokens', () => {
	it('produces url-safe, distinct tokens', () => {
		const a = randomToken();
		const b = randomToken();
		expect(a).not.toBe(b);
		expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it('hashes tokens deterministically to sha256 hex', () => {
		const h = hashToken('abc');
		expect(h).toMatch(/^[0-9a-f]{64}$/);
		expect(hashToken('abc')).toBe(h);
		expect(hashToken('abd')).not.toBe(h);
	});
});

describe('secret sealing', () => {
	it('round-trips a sealed secret', () => {
		const sealed = sealSecret('JBSWY3DPEHPK3PXP');
		expect(sealed.startsWith('v1.')).toBe(true);
		expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
		expect(openSecret(sealed)).toBe('JBSWY3DPEHPK3PXP');
	});

	it('rejects tampered ciphertext', () => {
		const sealed = sealSecret('topsecret');
		const parts = sealed.split('.');
		parts[3] = parts[3].slice(0, -2) + 'AA';
		expect(openSecret(parts.join('.'))).toBeNull();
	});

	it('rejects malformed input', () => {
		expect(openSecret('garbage')).toBeNull();
		expect(openSecret('v2.a.b.c')).toBeNull();
		expect(openSecret('v1.a.b')).toBeNull();
	});
});
