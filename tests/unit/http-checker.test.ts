import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCheck } from '$lib/server/monitor/checkers';
import { makeEgress } from '$lib/server/http/egress';
import type { ServiceConfig } from '$lib/server/config/schema';

const egress = makeEgress(() => true);

const CTX = {
	timeoutMs: 5000,
	degradedMs: 1000,
	userAgent: 'test-agent',
	certWarnDays: 14,
	egress
};

function httpService(
	overrides: Partial<Extract<ServiceConfig, { type: 'http' }>> = {}
): Extract<ServiceConfig, { type: 'http' }> {
	return {
		id: 'web',
		name: 'Web',
		group: 'General',
		type: 'http',
		url: 'https://example.com',
		method: 'GET',
		expected_statuses: [200],
		keyword_absent: false,
		follow_redirects: true,
		cert_check: false,
		...overrides
	};
}

afterEach(() => vi.unstubAllGlobals());

describe('http checker', () => {
	it('passes on expected status', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(new Response('ok', { status: 200 })))
		);
		const r = await runCheck(httpService(), CTX);
		expect(r.ok).toBe(true);
		expect(r.degraded).toBe(false);
	});

	it('fails on unexpected status', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(new Response('x', { status: 503 })))
		);
		const r = await runCheck(httpService(), CTX);
		expect(r.ok).toBe(false);
		expect(r.detail).toContain('503');
	});

	it('enforces keyword presence', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(new Response('hello world', { status: 200 })))
		);
		expect((await runCheck(httpService({ keyword: 'hello' }), CTX)).ok).toBe(true);
		const miss = await runCheck(httpService({ keyword: 'goodbye' }), CTX);
		expect(miss.ok).toBe(false);
		expect(miss.detail).toContain('keyword');
	});

	it('enforces keyword absence', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(new Response('error: maintenance', { status: 200 })))
		);
		const r = await runCheck(httpService({ keyword: 'maintenance', keyword_absent: true }), CTX);
		expect(r.ok).toBe(false);
	});

	it('fails on network error instead of throwing', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.reject(new Error('ECONNREFUSED')))
		);
		const r = await runCheck(httpService(), CTX);
		expect(r.ok).toBe(false);
		expect(r.detail).toContain('ECONNREFUSED');
	});
});
