import { describe, expect, it } from 'vitest';
import { RateLimiter } from '$lib/server/http/ratelimit';

describe('RateLimiter', () => {
	it('allows up to the limit then blocks', () => {
		const rl = new RateLimiter(3, 60_000);
		expect(rl.allow('a', 0)).toBe(true);
		expect(rl.allow('a', 1)).toBe(true);
		expect(rl.allow('a', 2)).toBe(true);
		expect(rl.allow('a', 3)).toBe(false);
		expect(rl.allow('b', 3)).toBe(true); // different key unaffected
	});

	it('resets after the window', () => {
		const rl = new RateLimiter(1, 100);
		expect(rl.allow('a', 0)).toBe(true);
		expect(rl.allow('a', 50)).toBe(false);
		expect(rl.allow('a', 101)).toBe(true);
	});
});
