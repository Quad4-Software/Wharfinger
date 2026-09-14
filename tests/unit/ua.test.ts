import { describe, expect, it } from 'vitest';
import { parseUA } from '$lib/shared/ua';

describe('parseUA', () => {
	it('handles empty input', () => {
		expect(parseUA(null).device).toBe('unknown');
		expect(parseUA('').browser).toBe('Unknown client');
	});

	it('detects desktop browsers and OS', () => {
		const ff = parseUA('Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0');
		expect(ff.browser).toBe('Firefox');
		expect(ff.os).toBe('Linux');
		expect(ff.device).toBe('desktop');

		const edge = parseUA(
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0'
		);
		expect(edge.browser).toBe('Edge');
		expect(edge.os).toBe('Windows');
	});

	it('detects mobile devices', () => {
		const ios = parseUA(
			'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'
		);
		expect(ios.device).toBe('mobile');
		expect(ios.os).toBe('iOS');
		expect(ios.browser).toBe('Safari');
	});

	it('detects bots and cli clients', () => {
		expect(parseUA('curl/8.5.0').device).toBe('cli');
		expect(parseUA('Googlebot/2.1 (+http://www.google.com/bot.html)').device).toBe('bot');
	});
});
