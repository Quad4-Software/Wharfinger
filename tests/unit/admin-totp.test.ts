import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
	base32Decode,
	base32Encode,
	generateTotpSecret,
	totpCode,
	totpUri,
	verifyTotp
} from '$lib/server/admin/totp';
import { TOTP_STEP_SECONDS } from '$lib/server/constants';

describe('base32', () => {
	it('round-trips arbitrary bytes', () => {
		for (let i = 0; i < 20; i++) {
			const buf = randomBytes(1 + (i % 20));
			expect(base32Decode(base32Encode(buf))).toEqual(buf);
		}
	});

	it('ignores whitespace and lowercase on decode', () => {
		const buf = randomBytes(10);
		const enc = base32Encode(buf);
		expect(base32Decode(enc.toLowerCase())).toEqual(buf);
		expect(base32Decode(enc.split('').join(' '))).toEqual(buf);
	});
});

describe('totp', () => {
	it('generates a decodable secret', () => {
		const s = generateTotpSecret();
		expect(s).toMatch(/^[A-Z2-7]+$/);
		expect(base32Decode(s)?.length).toBe(20);
	});

	it('produces stable 6-digit codes for a fixed instant', () => {
		const s = generateTotpSecret();
		const at = Date.parse('2026-09-13T12:00:00Z');
		const code = totpCode(s, at);
		expect(code).toMatch(/^\d{6}$/);
		expect(totpCode(s, at)).toBe(code);
	});

	it('changes across steps', () => {
		const s = generateTotpSecret();
		const at = Date.parse('2026-09-13T12:00:00Z');
		expect(totpCode(s, at)).not.toBe(totpCode(s, at + TOTP_STEP_SECONDS * 1000 + 1));
	});

	it('verifies a current code and rejects others', () => {
		const s = generateTotpSecret();
		const at = Date.parse('2026-09-13T12:00:00Z');
		const code = totpCode(s, at);
		expect(code).not.toBeNull();
		expect(verifyTotp(s, code ?? '', at)).toBe(true);
		expect(verifyTotp(s, 'abcdef', at)).toBe(false);
		expect(verifyTotp(s, '12345', at)).toBe(false);
	});

	it('accepts codes one step away within the window', () => {
		const s = generateTotpSecret();
		const at = Date.parse('2026-09-13T12:00:00Z');
		const prev = totpCode(s, at - TOTP_STEP_SECONDS * 1000);
		expect(verifyTotp(s, prev ?? '', at)).toBe(true);
	});

	it('rejects an undecodable secret', () => {
		expect(totpCode('')).toBeNull();
		expect(verifyTotp('', '123456')).toBe(false);
	});

	it('builds an otpauth uri', () => {
		const uri = totpUri('ABC123', 'alice@example.com', 'Quad4 Status');
		expect(uri).toContain('otpauth://totp/');
		expect(uri).toContain('secret=ABC123');
		expect(uri).toContain('alice%40example.com');
	});
});
