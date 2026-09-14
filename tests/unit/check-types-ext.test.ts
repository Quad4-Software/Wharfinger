import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import {
	headerScore,
	ircPings,
	ircReply,
	runCheck,
	tlsaMatch,
	xmppStreamReply,
	type TlsaRecordLike
} from '$lib/server/monitor/checkers';
import { makeEgress } from '$lib/server/http/egress';

// Loopback is always allowed by the egress guard, so the wire-level
// checks run against real local servers rather than mocked sockets.
const egress = makeEgress(() => false);
const CTX = { timeoutMs: 3000, degradedMs: 60_000, userAgent: 'test', certWarnDays: 14, egress };

const servers: Server[] = [];
const sockets: Socket[] = [];

function tcpServer(handler: (socket: Socket) => void): Promise<number> {
	const srv = createServer((s) => {
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

const xmpp = (port: number) =>
	({
		id: 'xm',
		name: 'XM',
		group: 'g',
		type: 'xmpp' as const,
		host: '127.0.0.1',
		port,
		domain: 'example.test',
		tls: false
	}) as Parameters<typeof runCheck>[0];
const irc = (port: number, over: Record<string, unknown> = {}) =>
	({
		id: 'ir',
		name: 'IR',
		group: 'g',
		type: 'irc' as const,
		host: '127.0.0.1',
		port,
		tls: false,
		...over
	}) as Parameters<typeof runCheck>[0];

describe('headerScore', () => {
	it('counts all six headers', () => {
		const h = new Headers({
			'strict-transport-security': 'max-age=31536000',
			'content-security-policy': "default-src 'self'",
			'x-frame-options': 'DENY',
			'x-content-type-options': 'nosniff',
			'referrer-policy': 'no-referrer',
			'permissions-policy': 'camera=()'
		});
		expect(headerScore(h)).toBe(6);
	});

	it('counts csp frame-ancestors as frame protection', () => {
		const h = new Headers({
			'content-security-policy': "default-src 'self'; frame-ancestors 'none'"
		});
		expect(headerScore(h)).toBe(2); // csp + frame check
	});

	it('scores zero on bare headers', () => {
		expect(headerScore(new Headers())).toBe(0);
		expect(headerScore(new Headers({ server: 'nginx' }))).toBe(0);
	});
});

describe('tlsaMatch', () => {
	const cert = Buffer.from('fake leaf cert der');
	const spki = Buffer.from('fake spki der');
	const rec = (over: Partial<TlsaRecordLike>): TlsaRecordLike => ({
		certUsage: 3,
		selector: 0,
		match: 0,
		data: cert,
		...over
	});

	it('matches an exact usage-3 selector-0 record', () => {
		expect(tlsaMatch([rec({})], cert, null)).toBe('match');
	});

	it('matches sha256 and sha512 association data', () => {
		const sha256 = createHash('sha256').update(cert).digest();
		expect(tlsaMatch([rec({ match: 1, data: sha256 })], cert, null)).toBe('match');
		const sha512 = createHash('sha512').update(cert).digest();
		expect(tlsaMatch([rec({ match: 2, data: sha512 })], cert, null)).toBe('match');
	});

	it('mismatches when evaluated usage-3 records miss', () => {
		const wrong = createHash('sha256').update('other cert').digest();
		expect(tlsaMatch([rec({ match: 1, data: wrong })], cert, null)).toBe('mismatch');
	});

	it('a matching record wins over a mismatching sibling', () => {
		const wrong = createHash('sha256').update('other cert').digest();
		const good = createHash('sha256').update(cert).digest();
		expect(
			tlsaMatch([rec({ match: 1, data: wrong }), rec({ match: 1, data: good })], cert, null)
		).toBe('match');
	});

	it('matches selector 1 against the SPKI when available', () => {
		const good = createHash('sha256').update(spki).digest();
		expect(tlsaMatch([rec({ selector: 1, match: 1, data: good })], cert, spki)).toBe('match');
	});

	it('is unvalidated for PKIX usages and unextractable selectors', () => {
		expect(tlsaMatch([rec({ certUsage: 2 })], cert, null)).toBe('unvalidated');
		expect(tlsaMatch([rec({ certUsage: 0 }), rec({ certUsage: 1 })], cert, spki)).toBe(
			'unvalidated'
		);
		// selector 1 without an SPKI cannot be evaluated.
		expect(
			tlsaMatch(
				[rec({ selector: 1, match: 1, data: createHash('sha256').update(spki).digest() })],
				cert,
				null
			)
		).toBe('unvalidated');
		// Unknown match types are skipped, not failed.
		expect(tlsaMatch([rec({ match: 9 })], cert, null)).toBe('unvalidated');
	});

	it('accepts ArrayBuffer data like Resolver.resolveTlsa returns', () => {
		const ab = cert.buffer.slice(cert.byteOffset, cert.byteOffset + cert.byteLength);
		expect(tlsaMatch([rec({ data: ab })], cert, null)).toBe('match');
	});

	it('returns null for no records', () => {
		expect(tlsaMatch([], cert, null)).toBeNull();
	});
});

describe('xmppStreamReply', () => {
	const open =
		"<?xml version='1.0'?><stream:stream xmlns='jabber:client' " +
		"xmlns:stream='http://etherx.jabber.org/streams' id='x' version='1.0'>";

	it('waits for stream features', () => {
		expect(xmppStreamReply(Buffer.from(open))).toBeNull();
		expect(xmppStreamReply(Buffer.from('<?xml version='))).toBeNull();
	});

	it('is ok once features arrive and names a few', () => {
		const buf = Buffer.from(
			open +
				'<stream:features><starttls xmlns="urn:ietf:params:xml:ns:xmpp-tls"/>' +
				'<mechanisms xmlns="urn:ietf:params:xml:ns:xmpp-sasl">' +
				'<mechanism>PLAIN</mechanism></mechanisms></stream:features>'
		);
		const r = xmppStreamReply(buf);
		expect(r?.ok).toBe(true);
		expect(r?.detail).toContain('starttls');
		expect(r?.detail).toContain('sasl');
	});

	it('fails on a stream error', () => {
		const buf = Buffer.from(open + '<stream:error><not-authorized/></stream:error>');
		const r = xmppStreamReply(buf);
		expect(r?.ok).toBe(false);
		expect(r?.detail).toBe('stream error');
	});

	it('fails when the server closes the stream', () => {
		expect(xmppStreamReply(Buffer.from(open + '</stream:stream>'))?.ok).toBe(false);
	});

	it('fails on a non-xml reply', () => {
		expect(xmppStreamReply(Buffer.from('HTTP/1.1 400 Bad Request\r\n'))?.ok).toBe(false);
	});
});

describe('ircReply', () => {
	it('is ok on 001 welcome and reports the server name', () => {
		const buf = Buffer.from(':irc.test 001 stat00 :Welcome to the test net\r\n');
		const r = ircReply(buf);
		expect(r?.ok).toBe(true);
		expect(r?.detail).toBe('irc irc.test welcome');
	});

	it('is ok on 433 nick in use', () => {
		const buf = Buffer.from(':irc.test 433 * stat00 :Nickname is already in use\r\n');
		const r = ircReply(buf);
		expect(r?.ok).toBe(true);
		expect(r?.detail).toContain('nick in use');
	});

	it('waits while only chatter has arrived', () => {
		expect(ircReply(Buffer.from(':irc.test NOTICE * :*** looking up\r\n'))).toBeNull();
		expect(ircReply(Buffer.from('PING :abc123\r\n'))).toBeNull();
		expect(ircReply(Buffer.from(''))).toBeNull();
	});

	it('waits on an unterminated line', () => {
		expect(ircReply(Buffer.from(':irc.test 001 stat00'))).toBeNull();
	});

	it('fails on ERROR and rejection numerics', () => {
		expect(ircReply(Buffer.from('ERROR :Closing link\r\n'))?.ok).toBe(false);
		expect(ircReply(Buffer.from(':i 465 stat00 :You are banned\r\n'))?.ok).toBe(false);
		expect(ircReply(Buffer.from(':i 464 stat00 :Password incorrect\r\n'))?.ok).toBe(false);
	});

	it('fails on a non-irc reply', () => {
		expect(ircReply(Buffer.from('HTTP/1.1 200 OK\r\n\r\n'))?.ok).toBe(false);
		expect(ircReply(Buffer.from('SSH-2.0-OpenSSH\r\n'))?.ok).toBe(false);
	});
});

describe('ircPings', () => {
	it('extracts ping tokens with and without the colon', () => {
		expect(ircPings(Buffer.from('PING :abc123\r\nPING def456\r\n'))).toEqual(['abc123', 'def456']);
		expect(ircPings(Buffer.from(':srv 001 n :hi\r\n'))).toEqual([]);
	});
});

describe('xmpp checker', () => {
	const features =
		"<?xml version='1.0'?><stream:stream xmlns='jabber:client' " +
		"xmlns:stream='http://etherx.jabber.org/streams' id='x' version='1.0'>" +
		'<stream:features><starttls/><mechanisms><mechanism>PLAIN</mechanism>' +
		'</mechanisms></stream:features>';

	it('is up on a stream:features reply', async () => {
		let got = '';
		const port = await tcpServer((s) => {
			s.on('data', (d: Buffer) => {
				got += d.toString('utf8');
				s.write(features);
			});
		});
		const r = await runCheck(xmpp(port), CTX);
		expect(r.ok).toBe(true);
		expect(r.detail).toContain('xmpp stream ok');
		// The opening stream carried the configured 'to' domain.
		expect(got).toContain("<stream:stream to='example.test'");
		expect(got).toContain("version='1.0'");
	});

	it('is down on a stream error', async () => {
		const port = await tcpServer((s) => {
			s.on('data', () =>
				s.write(
					"<?xml version='1.0'?><stream:stream id='x'><stream:error>" +
						'<host-unknown/></stream:error></stream:stream>'
				)
			);
		});
		const r = await runCheck(xmpp(port), CTX);
		expect(r.ok).toBe(false);
		expect(r.detail).toBe('stream error');
	});

	it('is down on a non-xmpp peer', async () => {
		const port = await tcpServer((s) => {
			s.on('data', () => s.write('HTTP/1.1 400 Bad Request\r\n\r\n'));
		});
		const r = await runCheck(xmpp(port), CTX);
		expect(r.ok).toBe(false);
	});
});

describe('irc checker', () => {
	it('is up on a 001 welcome', async () => {
		let got = '';
		const port = await tcpServer((s) => {
			s.on('data', (d: Buffer) => {
				got += d.toString('latin1');
				if (got.includes('USER')) s.write(':irc.test 001 statusmon :Welcome\r\n');
			});
		});
		const r = await runCheck(irc(port, { nick: 'statusmon' }), CTX);
		expect(r.ok).toBe(true);
		expect(r.detail).toBe('irc irc.test welcome');
		expect(got).toContain('NICK statusmon\r\n');
		expect(got).toContain('USER statusmon 0 * :status monitor\r\n');
	});

	it('answers PING with PONG before the welcome', async () => {
		let got = '';
		const port = await tcpServer((s) => {
			s.on('data', (d: Buffer) => {
				got += d.toString('latin1');
				if (!got.includes('PONG')) s.write('PING :cookie42\r\n');
				else s.write(':irc.test 001 stat00 :Welcome\r\n');
			});
		});
		const r = await runCheck(irc(port, { nick: 'stat00' }), CTX);
		expect(r.ok).toBe(true);
		expect(got).toContain('PONG :cookie42\r\n');
	});

	it('is up on nick-in-use', async () => {
		const port = await tcpServer((s) => {
			s.on('data', () => s.write(':irc.test 433 * statusmon :in use\r\n'));
		});
		const r = await runCheck(irc(port, { nick: 'statusmon' }), CTX);
		expect(r.ok).toBe(true);
		expect(r.detail).toContain('nick in use');
	});

	it('is down on ERROR', async () => {
		const port = await tcpServer((s) => {
			s.on('data', () => s.write('ERROR :Closing link\r\n'));
		});
		const r = await runCheck(irc(port), CTX);
		expect(r.ok).toBe(false);
	});
});
