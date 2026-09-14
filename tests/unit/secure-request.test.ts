import { describe, expect, it } from 'vitest';
import { isSecureRequest } from '$lib/server/admin/http';

// The cookie Secure flag follows the real socket protocol, which
// server.js stamps into x-wharfinger-proto (adapter-node reports https
// unconditionally when PROTOCOL_HEADER is unset). Regression cover
// for the admin-login-over-http breakage this caused.

const ev = (proto: string | null, urlProto = 'https:') =>
	({
		url: { protocol: urlProto },
		request: { headers: new Headers(proto ? { 'x-wharfinger-proto': proto } : {}) }
	}) as unknown as Parameters<typeof isSecureRequest>[0];

describe('isSecureRequest', () => {
	it('honors the stamped socket protocol', () => {
		expect(isSecureRequest(ev('https'))).toBe(true);
		expect(isSecureRequest(ev('http'))).toBe(false);
	});

	it('stamped http wins over a fake https url', () => {
		// The adapter-node default: url says https but the socket was http.
		expect(isSecureRequest(ev('http', 'https:'))).toBe(false);
	});

	it('falls back to the request url when no marker exists (dev)', () => {
		expect(isSecureRequest(ev(null, 'https:'))).toBe(true);
		expect(isSecureRequest(ev(null, 'http:'))).toBe(false);
	});
});
