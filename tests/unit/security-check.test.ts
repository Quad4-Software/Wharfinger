import { afterEach, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { Service, type ServiceConfig } from '$lib/server/config/schema';
import { runCheck } from '$lib/server/monitor/checkers';
import {
	cookieFindings,
	disclosureFindings,
	findMixedContent,
	headerChecks,
	parseCookieFlags,
	scoreFindings,
	securityTxtOk
} from '$lib/server/monitor/security-check';
import { EGRESS_BLOCKED_DETAIL, makeEgress } from '$lib/server/http/egress';

const egress = makeEgress(() => true);
const strictEgress = makeEgress(() => false);
const CTX = { timeoutMs: 3000, degradedMs: 60_000, userAgent: 'test', certWarnDays: 14, egress };
const STRICT_CTX = { ...CTX, egress: strictEgress };

type SecurityService = Extract<ServiceConfig, { type: 'security' }>;

function secService(overrides: Partial<SecurityService> = {}): SecurityService {
	return {
		id: 'sec',
		name: 'Sec',
		group: 'General',
		type: 'security',
		url: 'https://example.com/',
		...overrides
	};
}

const urlOf = (input: RequestInfo | URL): string =>
	typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const ALL_HEADERS = {
	'strict-transport-security': 'max-age=31536000',
	'content-security-policy': "default-src 'self'",
	'x-frame-options': 'DENY',
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'no-referrer',
	'permissions-policy': 'camera=()'
};

afterEach(() => vi.unstubAllGlobals());

describe('schema', () => {
	it('parses a minimal security service', () => {
		const r = v.safeParse(Service, {
			id: 'sec',
			name: 'Sec',
			type: 'security',
			url: 'https://example.com'
		});
		expect(r.success).toBe(true);
	});

	it('accepts checks and min_score', () => {
		const r = v.safeParse(Service, {
			id: 'sec',
			name: 'Sec',
			type: 'security',
			url: 'https://example.com',
			checks: ['headers', 'tls'],
			min_score: 70
		});
		expect(r.success).toBe(true);
	});

	it('rejects unknown check names, bad urls and out-of-range scores', () => {
		for (const extra of [
			{ checks: ['bogus'] },
			{ url: 'ftp://example.com' },
			{ min_score: 101 },
			{ min_score: -1 }
		]) {
			const r = v.safeParse(Service, {
				id: 'sec',
				name: 'Sec',
				type: 'security',
				url: 'https://example.com',
				...extra
			});
			expect(r.success).toBe(false);
		}
	});
});

describe('scoreFindings', () => {
	it('starts at 100 and clamps to 0', () => {
		expect(scoreFindings([])).toBe(100);
		const big = [
			{ check: 'headers' as const, severity: 'warn' as const, detail: 'x', penalty: 60 },
			{ check: 'tls' as const, severity: 'warn' as const, detail: 'y', penalty: 60 }
		];
		expect(scoreFindings(big)).toBe(0);
	});
});

describe('headerChecks', () => {
	it('is satisfied on the full six', () => {
		const r = headerChecks(new Headers(ALL_HEADERS), true);
		expect(r.satisfied).toBe(6);
		expect(r.findings).toHaveLength(0);
	});

	it('flags every missing header on https', () => {
		const r = headerChecks(new Headers(), true);
		expect(r.satisfied).toBe(0);
		expect(r.total).toBe(6);
		expect(r.findings).toHaveLength(6);
	});

	it('skips HSTS on plain http', () => {
		const r = headerChecks(new Headers(), false);
		expect(r.total).toBe(5);
		expect(r.findings.some((f) => f.detail.includes('HSTS'))).toBe(false);
	});

	it('counts csp frame-ancestors as frame protection', () => {
		const r = headerChecks(
			new Headers({ 'content-security-policy': "frame-ancestors 'none'" }),
			true
		);
		expect(r.findings.some((f) => f.detail === 'no frame protection')).toBe(false);
	});
});

describe('cookies', () => {
	it('parses flags case-insensitively', () => {
		const c = parseCookieFlags('session=abc123; Secure; httponly; SameSite=Lax; Path=/');
		expect(c.name).toBe('session');
		expect(c.secure).toBe(true);
		expect(c.httpOnly).toBe(true);
		expect(c.sameSite).toBe(true);
	});

	it('warns on missing Secure over https only', () => {
		const https = cookieFindings(['a=1'], true);
		expect(https.find((f) => f.detail.includes('Secure'))?.severity).toBe('warn');
		const http = cookieFindings(['a=1'], false);
		expect(http.every((f) => f.severity === 'info')).toBe(true);
	});

	it('flags missing HttpOnly and SameSite as info', () => {
		const r = cookieFindings(['a=1; Secure'], true);
		expect(r.find((f) => f.detail.includes('HttpOnly'))?.severity).toBe('info');
		expect(r.find((f) => f.detail.includes('SameSite'))?.severity).toBe('info');
	});

	it('returns nothing for no cookies', () => {
		expect(cookieFindings([], true)).toEqual([]);
	});
});

describe('findMixedContent', () => {
	it('finds http subresource attributes', () => {
		const html =
			'<img src="http://cdn.example.com/x.png"><script src="https://ok.example.com/a.js"></script>';
		const r = findMixedContent(html);
		expect(r.count).toBe(1);
		expect(r.samples[0]).toBe('http://cdn.example.com/x.png');
	});

	it('finds stylesheet links and css url()', () => {
		const html =
			'<link rel="stylesheet" href="http://cdn.example.com/x.css">' +
			'<div style="background:url(http://cdn.example.com/bg.png)"></div>';
		expect(findMixedContent(html).count).toBe(2);
	});

	it('ignores anchors and https urls', () => {
		expect(findMixedContent('<a href="http://example.com/page">x</a>').count).toBe(0);
		expect(findMixedContent('<img src="https://ok.example.com/x.png">').count).toBe(0);
	});

	it('splits srcset lists', () => {
		const html = '<img srcset="http://a.example.com/1.png 1x, http://a.example.com/2.png 2x">';
		expect(findMixedContent(html).count).toBe(2);
	});
});

describe('disclosureFindings', () => {
	it('warns on versioned tokens, info on bare names', () => {
		const r = disclosureFindings(new Headers({ server: 'nginx/1.24.0' }));
		expect(r[0].severity).toBe('warn');
		expect(disclosureFindings(new Headers({ server: 'nginx' }))[0].severity).toBe('info');
	});

	it('covers x-powered-by', () => {
		const r = disclosureFindings(new Headers({ 'x-powered-by': 'PHP/8.3' }));
		expect(r[0].detail).toContain('x-powered-by');
	});

	it('ignores absent headers', () => {
		expect(disclosureFindings(new Headers())).toEqual([]);
	});
});

describe('securityTxtOk', () => {
	it('requires a 200 and a Contact field', () => {
		expect(securityTxtOk(200, 'Contact: mailto:sec@example.com\nExpires: 2030-01-01')).toBe(true);
		expect(securityTxtOk(200, '<html>not found page</html>')).toBe(false);
		expect(securityTxtOk(404, 'Contact: mailto:sec@example.com')).toBe(false);
	});
});

describe('checkSecurity', () => {
	it('is down when the target is unreachable', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.reject(new Error('ECONNREFUSED')))
		);
		const r = await runCheck(secService({ checks: ['headers'] }), CTX);
		expect(r.ok).toBe(false);
		expect(r.detail).toContain('ECONNREFUSED');
	});

	it('is down on a blocked link-local target', async () => {
		const r = await runCheck(
			secService({ url: 'http://169.254.169.254/', checks: ['headers'] }),
			STRICT_CTX
		);
		expect(r.ok).toBe(false);
		expect(r.detail).toBe(EGRESS_BLOCKED_DETAIL);
	});

	it('stops after the redirect hop limit', async () => {
		const fetchMock = vi.fn(() =>
			Promise.resolve(new Response(null, { status: 302, headers: { location: '/next' } }))
		);
		vi.stubGlobal('fetch', fetchMock);
		const r = await runCheck(secService({ checks: ['redirects'] }), CTX);
		expect(fetchMock).toHaveBeenCalledTimes(6); // first request + 5 hops
		expect(r.ok).toBe(true);
		expect(r.degraded).toBe(true);
		expect(r.detail).toContain('redirect chain exceeds');
	});

	it('flags an https to http downgrade', async () => {
		const fetchMock = vi.fn((input: RequestInfo | URL) => {
			const url = urlOf(input);
			if (url.startsWith('https://')) {
				return Promise.resolve(
					new Response(null, { status: 302, headers: { location: 'http://example.com/' } })
				);
			}
			return Promise.resolve(new Response('x', { status: 200 }));
		});
		vi.stubGlobal('fetch', fetchMock);
		const r = await runCheck(secService({ checks: ['redirects'] }), CTX);
		expect(r.degraded).toBe(true);
		expect(r.detail).toContain('downgrades https to http');
	});

	it('scores headers and degrades below min_score', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() =>
				Promise.resolve(
					new Response('x', { status: 200, headers: { 'content-type': 'text/html' } })
				)
			)
		);
		const r = await runCheck(secService({ checks: ['headers'], min_score: 70 }), CTX);
		expect(r.ok).toBe(true);
		expect(r.degraded).toBe(true);
		expect(r.detail).toContain('score 61/100');
		expect(r.detail).toContain('below min_score 70');
	});

	it('stays up on a clean pass with security.txt', async () => {
		const fetchMock = vi.fn((input: RequestInfo | URL) => {
			const url = urlOf(input);
			if (url.includes('.well-known/security.txt')) {
				return Promise.resolve(
					new Response('Contact: mailto:sec@example.com\nExpires: 2030-01-01T00:00:00Z', {
						status: 200,
						headers: { 'content-type': 'text/plain' }
					})
				);
			}
			return Promise.resolve(
				new Response('<html><body>ok</body></html>', {
					status: 200,
					headers: { ...ALL_HEADERS, 'content-type': 'text/html' }
				})
			);
		});
		vi.stubGlobal('fetch', fetchMock);
		const r = await runCheck(
			secService({
				checks: ['headers', 'cookies', 'redirects', 'mixed-content', 'security-txt']
			}),
			CTX
		);
		expect(r.ok).toBe(true);
		expect(r.degraded).toBe(false);
		expect(r.detail).toContain('score 100/100');
		expect(r.detail).toContain('security.txt ok');
	});

	it('degrades on warnings even without min_score', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() =>
				Promise.resolve(
					new Response('x', {
						status: 200,
						headers: { server: 'nginx/1.24.0', 'x-powered-by': 'PHP/8.3' }
					})
				)
			)
		);
		const r = await runCheck(secService({ checks: ['server-disclosure'] }), CTX);
		expect(r.ok).toBe(true);
		expect(r.degraded).toBe(true);
		expect(r.detail).toContain('warn:');
	});

	it('mixes info-only findings into the score without degrading', async () => {
		const fetchMock = vi.fn((input: RequestInfo | URL) => {
			const url = urlOf(input);
			if (url.includes('.well-known/security.txt')) {
				return Promise.resolve(new Response('nope', { status: 404 }));
			}
			return Promise.resolve(
				new Response('x', {
					status: 200,
					headers: [['set-cookie', 'a=1; Secure; HttpOnly; SameSite=Lax']]
				})
			);
		});
		vi.stubGlobal('fetch', fetchMock);
		const r = await runCheck(secService({ checks: ['cookies', 'security-txt'] }), CTX);
		// Cookie is fully flagged, only the missing security.txt scores.
		expect(r.ok).toBe(true);
		expect(r.degraded).toBe(false);
		expect(r.detail).toContain('score 98/100');
	});
});
