import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEgress } from '$lib/server/http/egress';

const egress = makeEgress(() => true);

// Fake sockets driven by test-local state: openPorts accepts plain TCP,
// certDays controls the TLS peer certificate, tlsFails breaks handshakes.
const mockState = vi.hoisted(() => ({
	openPorts: new Set<number>(),
	certDays: 60,
	certAuthorized: true,
	tlsFails: false
}));

const { FakeSocket } = vi.hoisted(() => {
	// Minimal stand-in for net.Socket / tls.TLSSocket: once(), emit(), and
	// the methods the checkers touch.
	class FakeSocket {
		authorized = true;
		private listeners = new Map<string, ((...a: unknown[]) => void)[]>();
		setTimeout() {
			return this;
		}
		destroy() {
			return this;
		}
		once(ev: string, cb: (...a: unknown[]) => void) {
			const l = this.listeners.get(ev) ?? [];
			l.push(cb);
			this.listeners.set(ev, l);
			return this;
		}
		emit(ev: string, ...args: unknown[]) {
			for (const cb of this.listeners.get(ev) ?? []) cb(...args);
			return true;
		}
		getPeerCertificate() {
			return {
				valid_to: new Date(Date.now() + mockState.certDays * 86_400_000).toUTCString(),
				raw: Buffer.from('fake leaf der')
			};
		}
	}
	return { FakeSocket };
});

vi.mock('node:net', () => ({
	connect: (opts: { port: number }) => {
		const s = new FakeSocket();
		queueMicrotask(() => {
			if (mockState.openPorts.has(opts.port)) s.emit('connect');
			else s.emit('error', new Error('ECONNREFUSED'));
		});
		return s;
	}
}));

vi.mock('node:tls', () => ({
	connect: () => {
		const s = new FakeSocket();
		s.authorized = mockState.certAuthorized;
		queueMicrotask(() => {
			if (mockState.tlsFails) s.emit('error', new Error('handshake failure'));
			else s.emit('secureConnect');
		});
		return s;
	}
}));

const { runCheck } = await import('$lib/server/monitor/checkers');
const { daysUntil } = await import('$lib/server/monitor/tls');

const CTX = { timeoutMs: 2000, degradedMs: 500, userAgent: 'test', certWarnDays: 14, egress };

beforeEach(() => {
	mockState.openPorts = new Set();
	mockState.certDays = 60;
	mockState.certAuthorized = true;
	mockState.tlsFails = false;
});

afterEach(() => vi.unstubAllGlobals());

describe('tcp checker', () => {
	const svc = (over = {}) => ({
		id: 'db',
		name: 'DB',
		group: 'g',
		type: 'tcp' as const,
		host: '10.0.0.1',
		port: 5432,
		tls: false,
		...over
	});

	it('is up when the port accepts', async () => {
		mockState.openPorts = new Set([5432]);
		const r = await runCheck(svc(), CTX);
		expect(r.ok).toBe(true);
		expect(r.detail).toContain('5432');
	});

	it('is down when the port refuses', async () => {
		const r = await runCheck(svc(), CTX);
		expect(r.ok).toBe(false);
	});
});

describe('tcp + tls cert monitoring', () => {
	const svc = (over = {}) => ({
		id: 'ws',
		name: 'WS',
		group: 'g',
		type: 'tcp' as const,
		host: 'socket.example.com',
		port: 443,
		tls: true,
		...over
	});

	it('reports cert days when the handshake is trusted', async () => {
		const r = await runCheck(svc(), CTX);
		expect(r.ok).toBe(true);
		expect(r.degraded).toBe(false);
		expect(r.certDays).toBeGreaterThanOrEqual(59);
		expect(r.certDays).toBeLessThanOrEqual(60);
		expect(r.detail).toMatch(/cert \d+d/);
	});

	it('degrades when the cert nears expiry', async () => {
		mockState.certDays = 5;
		const r = await runCheck(svc(), CTX);
		expect(r.ok).toBe(true);
		expect(r.degraded).toBe(true);
		expect(r.certDays).toBeGreaterThanOrEqual(4);
		expect(r.certDays).toBeLessThanOrEqual(5);
	});

	it('fails on an untrusted cert', async () => {
		mockState.certAuthorized = false;
		const r = await runCheck(svc(), CTX);
		expect(r.ok).toBe(false);
	});

	it('fails when the handshake dies', async () => {
		mockState.tlsFails = true;
		const r = await runCheck(svc(), CTX);
		expect(r.ok).toBe(false);
		expect(r.detail).toContain('TLS');
	});
});

describe('ping checker (ip reachability)', () => {
	const svc = () => ({
		id: 'node',
		name: 'Node',
		group: 'g',
		type: 'ping' as const,
		host: '203.0.113.7',
		ports: [443, 80, 22]
	});

	it('is up when any probe port accepts', async () => {
		mockState.openPorts = new Set([22]);
		const r = await runCheck(svc(), CTX);
		expect(r.ok).toBe(true);
		expect(r.detail).toContain('22');
	});

	it('is down when every port is closed', async () => {
		const r = await runCheck(svc(), CTX);
		expect(r.ok).toBe(false);
		expect(r.detail).toContain('no probe port');
	});
});

describe('http cert monitoring', () => {
	const svc = (over = {}) => ({
		id: 'web',
		name: 'Web',
		group: 'g',
		type: 'http' as const,
		url: 'https://web.example.com',
		method: 'GET' as const,
		expected_statuses: [200],
		keyword_absent: false,
		follow_redirects: true,
		cert_check: true,
		...over
	});

	it('includes cert days in the outcome', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(new Response('ok', { status: 200 })))
		);
		const r = await runCheck(svc(), CTX);
		expect(r.ok).toBe(true);
		expect(r.certDays).toBeGreaterThanOrEqual(59);
		expect(r.certDays).toBeLessThanOrEqual(60);
		expect(r.detail).toMatch(/cert \d+d/);
	});

	it('degrades when cert expiry is inside the warn window', async () => {
		mockState.certDays = 3;
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(new Response('ok', { status: 200 })))
		);
		const r = await runCheck(svc(), CTX);
		expect(r.ok).toBe(true);
		expect(r.degraded).toBe(true);
	});

	it('skips the probe when cert_check is false', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(new Response('ok', { status: 200 })))
		);
		const r = await runCheck(svc({ cert_check: false }), CTX);
		expect(r.certDays).toBeUndefined();
		expect(r.detail).toBe('HTTP 200');
	});
});

describe('daysUntil', () => {
	it('computes whole days', () => {
		const now = Date.parse('2026-09-13T12:00:00Z');
		expect(daysUntil('2026-09-20T12:00:00Z', now)).toBe(7);
		expect(daysUntil('2026-09-13T13:00:00Z', now)).toBe(0);
		expect(daysUntil('2026-09-10T12:00:00Z', now)).toBe(-3);
	});
});
