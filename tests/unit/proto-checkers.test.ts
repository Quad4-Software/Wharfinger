import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
	createServer as createHttpServer,
	type IncomingMessage,
	type Server as HttpServer
} from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import {
	mysqlHandshake,
	pgReply,
	pgStartup,
	rdapBaseFor,
	rdapExpiry,
	redisReply,
	runCheck,
	wsAccept,
	wsHandshakeReply
} from '$lib/server/monitor/checkers';
import { makeEgress } from '$lib/server/http/egress';

// Loopback is always allowed by the egress guard, so the checkers run
// against real local servers rather than mocked sockets.
const egress = makeEgress(() => false);
const CTX = { timeoutMs: 3000, degradedMs: 60_000, userAgent: 'test', certWarnDays: 14, egress };

const servers: (TcpServer | HttpServer)[] = [];
const sockets: Socket[] = [];

function tcpServer(handler: (socket: Socket) => void): Promise<number> {
	const srv = createTcpServer((s) => {
		sockets.push(s);
		handler(s);
	});
	servers.push(srv);
	return new Promise((resolve) => {
		srv.listen(0, '127.0.0.1', () => {
			resolve((srv.address() as { port: number }).port);
		});
	});
}

afterEach(async () => {
	vi.unstubAllGlobals();
	// close() alone waits forever on open and hijacked upgrade sockets.
	for (const s of sockets.splice(0)) s.destroy();
	while (servers.length) {
		const srv = servers.pop();
		await new Promise((r) =>
			srv?.close(() => {
				r(undefined);
			})
		);
	}
});

const pg = (over: Record<string, unknown> = {}) =>
	({
		id: 'pg',
		name: 'PG',
		group: 'g',
		type: 'postgres' as const,
		host: '127.0.0.1',
		port: 1,
		...over
	}) as Parameters<typeof runCheck>[0];
const my = (port: number) =>
	({
		id: 'my',
		name: 'MY',
		group: 'g',
		type: 'mysql' as const,
		host: '127.0.0.1',
		port
	}) as Parameters<typeof runCheck>[0];
const rd = (port: number) =>
	({
		id: 'rd',
		name: 'RD',
		group: 'g',
		type: 'redis' as const,
		host: '127.0.0.1',
		port
	}) as Parameters<typeof runCheck>[0];
const ws = (url: string) =>
	({ id: 'ws', name: 'WS', group: 'g', type: 'websocket' as const, url }) as Parameters<
		typeof runCheck
	>[0];
const rdap = (domain: string) =>
	({
		id: 'dm',
		name: 'DM',
		group: 'g',
		type: 'rdap' as const,
		domain,
		warn_days: 14
	}) as Parameters<typeof runCheck>[0];

describe('postgres checker', () => {
	const authOk = () => {
		const body = Buffer.alloc(4); // AuthenticationOk: int32 0
		const head = Buffer.alloc(5);
		head.write('R');
		head.writeUInt32BE(8, 1);
		return Buffer.concat([head, body]);
	};

	it('is up on an AuthenticationOk reply', async () => {
		let got = Buffer.alloc(0);
		const port = await tcpServer((s) => {
			s.on('data', (d: Buffer) => {
				got = Buffer.concat([got, d]);
				s.write(authOk());
			});
		});
		const r = await runCheck(pg({ port }), CTX);
		expect(r.ok).toBe(true);
		expect(r.detail).toContain('postgres');
		// The StartupMessage carried the default user and protocol 3.0.
		expect(got.readUInt32BE(4)).toBe(196608);
		expect(got.toString('utf8')).toContain('user\0monitor\0');
	});

	it('is up on an ErrorResponse (liveness, not auth)', async () => {
		const err = Buffer.concat([
			Buffer.from('E'),
			Buffer.from([0, 0, 0, 0]),
			Buffer.from('SFATAL\0Mpassword authentication failed for user "monitor"\0\0')
		]);
		err.writeUInt32BE(err.length - 1, 1);
		const port = await tcpServer((s) => {
			s.on('data', () => s.write(err));
		});
		const r = await runCheck(pg({ port }), CTX);
		expect(r.ok).toBe(true);
		expect(r.detail).toContain('password authentication failed');
	});

	it('is down on a non-postgres reply', async () => {
		const port = await tcpServer((s) => {
			s.on('data', () => s.write('HTTP/1.1 400 Bad Request\r\n\r\n'));
		});
		const r = await runCheck(pg({ port }), CTX);
		expect(r.ok).toBe(false);
	});

	it('is down when the connection drops', async () => {
		const port = await tcpServer((s) => s.destroy());
		const r = await runCheck(pg({ port }), CTX);
		expect(r.ok).toBe(false);
	});

	it('sends the configured user and database', async () => {
		let got = Buffer.alloc(0);
		const port = await tcpServer((s) => {
			s.on('data', (d: Buffer) => {
				got = Buffer.concat([got, d]);
				s.write(authOk());
			});
		});
		const r = await runCheck(pg({ port, user: 'alice', database: 'shop' }), CTX);
		expect(r.ok).toBe(true);
		expect(got.toString('utf8')).toContain('user\0alice\0database\0shop\0');
	});
});

describe('pgStartup / pgReply', () => {
	it('frames a valid StartupMessage', () => {
		const b = pgStartup('monitor', 'db1');
		expect(b.readUInt32BE(0)).toBe(b.length);
		expect(b.readUInt32BE(4)).toBe(196608);
		expect(b.toString('utf8', 8)).toBe('user\0monitor\0database\0db1\0\0');
	});

	it('parses the first reply byte', () => {
		expect(pgReply(Buffer.alloc(3))).toBeNull();
		const r = Buffer.alloc(9);
		r.write('R');
		r.writeUInt32BE(8, 1);
		expect(pgReply(r)?.ok).toBe(true);
		expect(pgReply(Buffer.from('HTTP/1.1'))?.ok).toBe(false);
	});
});

describe('mysql checker', () => {
	const handshake = (version: string) => {
		const payload = Buffer.concat([
			Buffer.from([0x0a]),
			Buffer.from(`${version}\0`),
			Buffer.alloc(20)
		]);
		const head = Buffer.alloc(4);
		head.writeUIntLE(payload.length, 0, 3);
		head.writeUInt8(0, 3);
		return Buffer.concat([head, payload]);
	};

	it('is up on a valid handshake and reports the version', async () => {
		const port = await tcpServer((s) => s.write(handshake('8.0.36-test')));
		const r = await runCheck(my(port), CTX);
		expect(r.ok).toBe(true);
		expect(r.detail).toBe('mysql 8.0.36-test');
	});

	it('is up on an ERR packet', async () => {
		const payload = Buffer.concat([Buffer.from([0xff]), Buffer.from('blocked host')]);
		const head = Buffer.alloc(4);
		head.writeUIntLE(payload.length, 0, 3);
		head.writeUInt8(0, 3);
		const port = await tcpServer((s) => s.write(Buffer.concat([head, payload])));
		const r = await runCheck(my(port), CTX);
		expect(r.ok).toBe(true);
	});

	it('is down on garbage', async () => {
		const port = await tcpServer((s) => s.write('SSH-2.0-OpenSSH_9.6\r\n'));
		const r = await runCheck(my(port), CTX);
		expect(r.ok).toBe(false);
	});

	it('is down when the peer closes silently', async () => {
		const port = await tcpServer((s) => s.end());
		const r = await runCheck(my(port), CTX);
		expect(r.ok).toBe(false);
	});
});

describe('mysqlHandshake', () => {
	it('waits for 5 bytes, then validates the protocol byte', () => {
		expect(mysqlHandshake(Buffer.alloc(4))).toBeNull();
		expect(mysqlHandshake(Buffer.from('\x01\x00\x00\x00\x0a', 'latin1'))?.ok).toBe(true);
		expect(mysqlHandshake(Buffer.from('\x01\x00\x00\x00\x07', 'latin1'))?.ok).toBe(false);
	});
});

describe('redis checker', () => {
	it('is up on +PONG', async () => {
		const port = await tcpServer((s) => {
			s.on('data', () => s.write('+PONG\r\n'));
		});
		const r = await runCheck(rd(port), CTX);
		expect(r.ok).toBe(true);
		expect(r.detail).toBe('redis +PONG');
	});

	it('is up on -NOAUTH (auth-gated still proves liveness)', async () => {
		const port = await tcpServer((s) => {
			s.on('data', () => s.write('-NOAUTH Authentication required.\r\n'));
		});
		const r = await runCheck(rd(port), CTX);
		expect(r.ok).toBe(true);
		expect(r.detail).toContain('NOAUTH');
	});

	it('is down on a non-RESP reply', async () => {
		const port = await tcpServer((s) => {
			s.on('data', () => s.write('HTTP/1.1 200 OK\r\n\r\n'));
		});
		const r = await runCheck(rd(port), CTX);
		expect(r.ok).toBe(false);
	});
});

describe('redisReply', () => {
	it('accepts + and - lines, rejects other bytes', () => {
		expect(redisReply(Buffer.from('+PONG\r\n'))?.ok).toBe(true);
		expect(redisReply(Buffer.from('-ERR nope\r\n'))?.ok).toBe(true);
		expect(redisReply(Buffer.from('+PO'))).toBeNull();
		expect(redisReply(Buffer.from('$3\r\n'))?.ok).toBe(false);
	});
});

const BOOTSTRAP = {
	services: [
		[['io'], ['https://rdap.example.io/']],
		[['dev'], ['http://insecure.example/']]
	]
};

function rdapDoc(eventDate: string) {
	return {
		events: [
			{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' },
			{ eventAction: 'expiration', eventDate }
		]
	};
}

function stubRdapFetch(domainBody: unknown, domainStatus = 200) {
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string | URL) => {
			const u = String(url);
			if (u.includes('iana.org')) return Promise.resolve(Response.json(BOOTSTRAP));
			if (domainStatus !== 200) {
				return Promise.resolve(new Response('nope', { status: domainStatus }));
			}
			return Promise.resolve(Response.json(domainBody));
		})
	);
}

describe('rdap checker', () => {
	it('is up when expiry is beyond warn_days', async () => {
		stubRdapFetch(rdapDoc(new Date(Date.now() + 60 * 86_400_000).toISOString()));
		const r = await runCheck(rdap('example.io'), CTX);
		expect(r.ok).toBe(true);
		expect(r.degraded).toBe(false);
		expect(r.detail).toMatch(/expires in (59|60)d/);
	});

	it('degrades inside warn_days', async () => {
		stubRdapFetch(rdapDoc(new Date(Date.now() + 5 * 86_400_000).toISOString()));
		const r = await runCheck(rdap('example.io'), CTX);
		expect(r.ok).toBe(true);
		expect(r.degraded).toBe(true);
	});

	it('is down when expired', async () => {
		stubRdapFetch(rdapDoc(new Date(Date.now() - 3 * 86_400_000).toISOString()));
		const r = await runCheck(rdap('example.io'), CTX);
		expect(r.ok).toBe(false);
		expect(r.detail).toContain('expired');
	});

	it('is down on a 404', async () => {
		stubRdapFetch(null, 404);
		const r = await runCheck(rdap('example.io'), CTX);
		expect(r.ok).toBe(false);
		expect(r.detail).toBe('domain not found');
	});

	it('falls back to verisign for .com when the bootstrap lacks it', async () => {
		stubRdapFetch(rdapDoc(new Date(Date.now() + 30 * 86_400_000).toISOString()));
		const r = await runCheck(rdap('example.com'), CTX);
		expect(r.ok).toBe(true);
		const called = vi
			.mocked(fetch)
			.mock.calls.map(([u]) => (typeof u === 'string' ? u : u instanceof URL ? u.href : u.url));
		expect(called.some((u) => u.includes('verisign'))).toBe(true);
	});

	it('is down when no rdap server serves the tld', async () => {
		stubRdapFetch(rdapDoc('2030-01-01T00:00:00Z'));
		const r = await runCheck(rdap('example.xyz'), CTX);
		expect(r.ok).toBe(false);
		expect(r.detail).toContain('no rdap server');
	});

	it('is down when there is no expiration event', async () => {
		stubRdapFetch({ events: [{ eventAction: 'registration', eventDate: '2020-01-01' }] });
		const r = await runCheck(rdap('example.io'), CTX);
		expect(r.ok).toBe(false);
		expect(r.detail).toContain('no expiration');
	});
});

describe('rdapBaseFor / rdapExpiry', () => {
	it('maps a tld to its https base url', () => {
		expect(rdapBaseFor(BOOTSTRAP, 'io')).toBe('https://rdap.example.io/');
		expect(rdapBaseFor(BOOTSTRAP, 'dev')).toBeNull(); // http-only is skipped
		expect(rdapBaseFor(BOOTSTRAP, 'xyz')).toBeNull();
		expect(rdapBaseFor(null, 'io')).toBeNull();
	});

	it('extracts the expiration eventDate', () => {
		expect(rdapExpiry(rdapDoc('2031-06-15T00:00:00Z'))).toBe(Date.parse('2031-06-15T00:00:00Z'));
		expect(
			rdapExpiry({ events: [{ eventAction: 'expiration date', eventDate: '2031-01-01' }] })
		).toBe(Date.parse('2031-01-01'));
		expect(
			rdapExpiry({ events: [{ eventAction: 'last changed', eventDate: '2031-01-01' }] })
		).toBeNull();
		expect(rdapExpiry({})).toBeNull();
	});
});

describe('websocket checker', () => {
	const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

	function wsServer(upgrade: (req: IncomingMessage, socket: Socket) => void): Promise<number> {
		const srv = createHttpServer((_req, res) => {
			res.writeHead(200).end('ok');
		});
		srv.on('upgrade', (req, socket) => {
			sockets.push(socket as Socket);
			upgrade(req, socket as Socket);
		});
		servers.push(srv);
		return new Promise((resolve) => {
			srv.listen(0, '127.0.0.1', () => {
				resolve((srv.address() as { port: number }).port);
			});
		});
	}

	it('is up on a valid 101 upgrade', async () => {
		const port = await wsServer((req, socket) => {
			const key = req.headers['sec-websocket-key'];
			const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
			socket.write(
				'HTTP/1.1 101 Switching Protocols\r\n' +
					'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
					`Sec-WebSocket-Accept: ${accept}\r\n\r\n`
			);
		});
		const r = await runCheck(ws(`ws://127.0.0.1:${port}/sock`), CTX);
		expect(r.ok).toBe(true);
		expect(r.detail).toBe('websocket upgrade ok');
	});

	it('is down on a plain HTTP response', async () => {
		const srv = createHttpServer((_req, res) => res.writeHead(200).end('ok'));
		servers.push(srv);
		const port = await new Promise<number>((resolve) => {
			srv.listen(0, '127.0.0.1', () => {
				resolve((srv.address() as { port: number }).port);
			});
		});
		const r = await runCheck(ws(`ws://127.0.0.1:${port}/`), CTX);
		expect(r.ok).toBe(false);
		expect(r.detail).toContain('200');
	});

	it('is down when the accept key is wrong', async () => {
		const port = await wsServer((_req, socket) => {
			socket.write(
				'HTTP/1.1 101 Switching Protocols\r\n' +
					'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
					'Sec-WebSocket-Accept: bogus\r\n\r\n'
			);
		});
		const r = await runCheck(ws(`ws://127.0.0.1:${port}/`), CTX);
		expect(r.ok).toBe(false);
		expect(r.detail).toContain('Sec-WebSocket-Accept');
	});
});

describe('wsAccept / wsHandshakeReply', () => {
	it('computes the RFC 6455 accept hash', () => {
		expect(wsAccept('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
	});

	it('waits for the header terminator and validates 101 + accept', () => {
		const key = 'x3JJHMbDL1EzLkh9GBhXDw==';
		expect(wsHandshakeReply(Buffer.from('HTTP/1.1 101 Switching'), key)).toBeNull();
		const good = Buffer.from(
			`HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
		);
		expect(wsHandshakeReply(good, key)?.ok).toBe(true);
		const wrongKey = Buffer.from(
			'HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: aaaa\r\n\r\n'
		);
		expect(wsHandshakeReply(wrongKey, key)?.ok).toBe(false);
		const plain = Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
		expect(wsHandshakeReply(plain, key)?.detail).toContain('200');
	});
});
