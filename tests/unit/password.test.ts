import { describe, expect, it } from 'vitest';
import { passwordStrength } from '$lib/shared/password';

describe('passwordStrength', () => {
	it('empty input reports nothing, no rejection', () => {
		const s = passwordStrength('');
		expect(s.score).toBe(0);
		expect(s.rejected).toBeNull();
		expect(s.hints).toEqual([]);
	});

	it('rejects passwords under the policy floor', () => {
		const s = passwordStrength('short');
		expect(s.rejected).toContain('12 characters');
		expect(s.score).toBeLessThanOrEqual(1);
	});

	it('rejects passwords containing the username', () => {
		const s = passwordStrength('ivanStatus2026!!', { username: 'ivan' });
		expect(s.rejected).toBe('must not contain the username');
	});

	it('caps common-word passwords as weak', () => {
		expect(passwordStrength('passwordpassword1').score).toBeLessThanOrEqual(1);
		expect(passwordStrength('Qwerty12345xxx').score).toBeLessThanOrEqual(2);
	});

	it('caps sequences and repeats', () => {
		expect(passwordStrength('abcd1234abcd!').score).toBeLessThanOrEqual(2);
		expect(passwordStrength('xxAAAaaaAAAxx1!').score).toBeLessThanOrEqual(2);
	});

	it('rewards length and class variety', () => {
		const strong = passwordStrength('correct horse battery staple 9!');
		expect(strong.score).toBe(4);
		expect(strong.rejected).toBeNull();
		expect(strong.hints).toEqual([]);
	});

	it('respects a custom minimum length', () => {
		expect(passwordStrength('eight8!!', { minLength: 8 }).rejected).toBeNull();
		expect(passwordStrength('eight8!!', { minLength: 16 }).rejected).not.toBeNull();
	});
});

describe('uptimeFractionInRows', () => {
	it('matches SUM(ok)/COUNT(*) semantics on seeded rows', async () => {
		const { openDb } = await import('$lib/server/store/db');
		const { CheckStore } = await import('$lib/server/store/checks');
		const { uptimeFractionInRows } = await import('$lib/shared/uptime');
		const db = openDb(':memory:');
		const store = new CheckStore(db);
		const now = Date.now();
		for (let i = 0; i < 200; i++) {
			store.record(
				'svc',
				{ ok: i % 4 !== 0, latencyMs: 10, status: i % 4 !== 0 ? 'up' : 'down' },
				now - i * 60_000
			);
		}
		const rows = store.since('svc', now - 3 * 3600_000);
		for (const w of [3600_000, 2 * 3600_000, 90_000]) {
			expect(uptimeFractionInRows(rows, now - w)).toBeCloseTo(
				store.uptimeFraction('svc', now - w) ?? -1,
				10
			);
		}
		expect(uptimeFractionInRows(rows, now + 1000)).toBeNull();
		expect(store.uptimeFraction('svc', now + 1000)).toBeNull();
	});
});
