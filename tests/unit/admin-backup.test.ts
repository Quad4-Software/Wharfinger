import { describe, expect, it } from 'vitest';
import {
	isPassphraseEnvelope,
	openWithPassphrase,
	sealWithPassphrase,
	type PassphraseEnvelope
} from '$lib/server/admin/crypto';

process.env.WHARFINGER_SECRET_KEY = 'unit-test-secret-key-material';

describe('passphrase envelope', () => {
	it('round-trips a sealed payload', () => {
		const env = sealWithPassphrase('{"services":[]}', 'correct horse');
		expect(env.v).toBe(1);
		expect(env.kdf).toBe('scrypt');
		expect(JSON.stringify(env)).not.toContain('services');
		expect(openWithPassphrase(env, 'correct horse')).toBe('{"services":[]}');
	});

	it('rejects a wrong passphrase without detail', () => {
		const env = sealWithPassphrase('secret', 'right');
		expect(openWithPassphrase(env, 'wrong')).toBeNull();
		expect(openWithPassphrase(env, '')).toBeNull();
	});

	it('rejects tampered ciphertext', () => {
		const env = sealWithPassphrase('secret', 'pw');
		env.ct = `${env.ct.slice(0, -2)}AA`;
		expect(openWithPassphrase(env, 'pw')).toBeNull();
	});

	it('rejects malformed envelopes', () => {
		expect(openWithPassphrase('garbage', 'pw')).toBeNull();
		expect(openWithPassphrase(null, 'pw')).toBeNull();
		expect(openWithPassphrase({ v: 2, kdf: 'scrypt' }, 'pw')).toBeNull();
		expect(openWithPassphrase({ v: 1, kdf: 'scrypt', N: 16384, r: 8, p: 1 }, 'pw')).toBeNull();
	});

	it('rejects out-of-range kdf params', () => {
		const env = sealWithPassphrase('secret', 'pw');
		expect(openWithPassphrase({ ...env, N: 1000 }, 'pw')).toBeNull(); // not a power of two
		expect(openWithPassphrase({ ...env, N: 1 << 24 }, 'pw')).toBeNull(); // too large
		expect(openWithPassphrase({ ...env, r: 0 }, 'pw')).toBeNull();
		expect(openWithPassphrase({ ...env, p: -1 }, 'pw')).toBeNull();
	});
});

describe('envelope detection', () => {
	it('flags a sealed envelope', () => {
		expect(isPassphraseEnvelope(sealWithPassphrase('x', 'pw'))).toBe(true);
	});

	it('does not flag a plaintext backup config map', () => {
		expect(isPassphraseEnvelope({ site: { name: 'x' }, services: [] })).toBe(false);
		expect(isPassphraseEnvelope({})).toBe(false);
		expect(isPassphraseEnvelope(null)).toBe(false);
		expect(isPassphraseEnvelope([1, 2])).toBe(false);
	});

	it('is not fooled by partial lookalikes', () => {
		const env: PassphraseEnvelope = sealWithPassphrase('x', 'pw');
		expect(isPassphraseEnvelope({ ...env, ct: 42 })).toBe(false);
		expect(isPassphraseEnvelope({ ...env, kdf: 'pbkdf2' })).toBe(false);
	});
});
