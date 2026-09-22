import { describe, expect, it } from 'vitest';
import { isLoopbackAddr, isPrivateAddr, proxyTrustMode, trustForwarded } from '$lib/server/proxy';

describe('proxyTrustMode', () => {
	it('is never when unset or unrecognized', () => {
		expect(proxyTrustMode({})).toBe('never');
		expect(proxyTrustMode({ WHARFINGER_TRUST_PROXY: 'bogus' })).toBe('never');
	});

	it('maps each env spelling to its mode', () => {
		for (const v of ['1', 'true', 'yes', 'all', 'always']) {
			expect(proxyTrustMode({ WHARFINGER_TRUST_PROXY: v })).toBe('all');
		}
		for (const v of ['loopback', 'local']) {
			expect(proxyTrustMode({ WHARFINGER_TRUST_PROXY: v })).toBe('loopback');
		}
		for (const v of ['lan', 'private']) {
			expect(proxyTrustMode({ WHARFINGER_TRUST_PROXY: v })).toBe('lan');
		}
	});
});

describe('address classification', () => {
	it('recognizes loopback including v4-mapped', () => {
		for (const a of ['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1']) {
			expect(isLoopbackAddr(a)).toBe(true);
		}
		expect(isLoopbackAddr('10.0.0.1')).toBe(false);
		expect(isLoopbackAddr('::ffff:10.0.0.1')).toBe(false);
	});

	it('recognizes private, link-local, CGNAT, and ULA peers', () => {
		for (const a of [
			'10.1.2.3',
			'172.16.0.9',
			'172.31.255.1',
			'192.168.1.20',
			'169.254.1.1',
			'100.64.0.1',
			'fc00::1',
			'fd12::ab',
			'fe80::1',
			'::ffff:192.168.0.1'
		]) {
			expect(isPrivateAddr(a)).toBe(true);
		}
		for (const a of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '11.0.0.1', '2001:db8::1']) {
			expect(isPrivateAddr(a)).toBe(false);
		}
	});
});

describe('trustForwarded', () => {
	it('never trusts forwarded headers without opt-in', () => {
		expect(trustForwarded('127.0.0.1', {})).toBe(false);
		expect(trustForwarded('10.0.0.1', {})).toBe(false);
	});

	it('trusts any peer in all mode', () => {
		const env = { WHARFINGER_TRUST_PROXY: '1' };
		expect(trustForwarded('8.8.8.8', env)).toBe(true);
		expect(trustForwarded(null, env)).toBe(true);
	});

	it('scopes loopback mode to same-host proxies', () => {
		const env = { WHARFINGER_TRUST_PROXY: 'loopback' };
		expect(trustForwarded('127.0.0.1', env)).toBe(true);
		expect(trustForwarded('::1', env)).toBe(true);
		expect(trustForwarded('::ffff:127.0.0.1', env)).toBe(true);
		expect(trustForwarded('10.0.0.5', env)).toBe(false);
		expect(trustForwarded(null, env)).toBe(false);
	});

	it('scopes lan mode to private peers', () => {
		const env = { WHARFINGER_TRUST_PROXY: 'lan' };
		expect(trustForwarded('127.0.0.1', env)).toBe(true);
		expect(trustForwarded('192.168.1.2', env)).toBe(true);
		expect(trustForwarded('fd00::5', env)).toBe(true);
		expect(trustForwarded('203.0.113.9', env)).toBe(false);
		expect(trustForwarded(null, env)).toBe(false);
	});
});
