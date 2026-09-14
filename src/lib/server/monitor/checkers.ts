import { connect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { createHash, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import type { ServiceConfig } from '$lib/server/config/schema';
import {
	blockedHost,
	EGRESS_BLOCKED_DETAIL,
	type Egress,
	type FetchInit
} from '$lib/server/http/egress';
import { daysUntil, probeCert } from './tls';

export interface CheckOutcome {
	/** Passed all assertions. */
	ok: boolean;
	/** Passed but slower than degraded_ms or nearing cert expiry. */
	degraded: boolean;
	latencyMs: number;
	/** Human readable failure reason or metric note. */
	detail?: string;
	/** Days until TLS cert expiry, when the service is TLS monitored. */
	certDays?: number;
}

export interface CheckContext {
	timeoutMs: number;
	degradedMs: number;
	userAgent: string;
	/** Certs expiring within this many days degrade the service. */
	certWarnDays: number;
	/** Outbound connection policy shared with notification senders. */
	egress: Egress;
	/** Last check-in ms for push services, null when never beaten. */
	lastBeat?: (serviceId: string) => number | null;
}

const MAX_BODY_BYTES = 1024 * 1024;

export async function runCheck(service: ServiceConfig, ctx: CheckContext): Promise<CheckOutcome> {
	try {
		switch (service.type) {
			case 'http':
				return await checkHttp(service, ctx);
			case 'tcp':
				return await checkTcp(service, ctx);
			case 'push':
				return checkPush(service, ctx);
			case 'ping':
				return await checkPing(service, ctx);
			case 'dns':
				return await checkDns(service, ctx);
			case 'a2s':
				return await checkA2s(service, ctx);
			case 'json':
				return await checkJson(service, ctx);
			case 'postgres':
				return await checkPostgres(service, ctx);
			case 'mysql':
				return await checkMysql(service, ctx);
			case 'redis':
				return await checkRedis(service, ctx);
			case 'rdap':
				return await checkRdap(service, ctx);
			case 'domain':
				return await checkDomain(service, ctx);
			case 'xmpp':
				return await checkXmpp(service, ctx);
			case 'irc':
				return await checkIrc(service, ctx);
			case 'websocket':
				return await checkWebsocket(service, ctx);
		}
	} catch (err) {
		return { ok: false, degraded: false, latencyMs: ctx.timeoutMs, detail: errMessage(err) };
	}
}

async function checkHttp(
	service: Extract<ServiceConfig, { type: 'http' }>,
	ctx: CheckContext
): Promise<CheckOutcome> {
	const url = new URL(service.url);
	if (!ctx.egress.allowLinkLocal() && blockedHost(url.hostname)) {
		return { ok: false, degraded: false, latencyMs: 0, detail: EGRESS_BLOCKED_DETAIL };
	}
	const wantsCert = url.protocol === 'https:' && service.cert_check;
	const port = url.port ? Number(url.port) : 443;

	// Cert probe runs alongside the request; a slow handshake never
	// delays the actual status check.
	const certProbe = wantsCert
		? probeCert(url.hostname, port, ctx.timeoutMs, url.hostname, ctx.egress.lookup)
		: null;

	const started = performance.now();
	const res = await fetch(service.url, {
		method: service.method,
		redirect: service.follow_redirects ? 'follow' : 'manual',
		dispatcher: ctx.egress.dispatcher,
		signal: AbortSignal.timeout(ctx.timeoutMs),
		headers: {
			'user-agent': ctx.userAgent,
			accept: '*/*',
			...service.headers
		}
	} as FetchInit);
	const latencyMs = performance.now() - started;

	if (!service.expected_statuses.includes(res.status)) {
		return {
			ok: false,
			degraded: false,
			latencyMs,
			detail: `unexpected status ${res.status}`
		};
	}

	if (service.keyword) {
		const body = await readBounded(res, MAX_BODY_BYTES);
		const found = body.includes(service.keyword);
		if (found === service.keyword_absent) {
			return {
				ok: false,
				degraded: false,
				latencyMs,
				detail: service.keyword_absent
					? `forbidden keyword present`
					: `keyword not found in response`
			};
		}
	} else if (service.method === 'GET') {
		// Drain so the socket can be reused.
		await res.arrayBuffer().catch(() => undefined);
	}

	let certDays: number | undefined;
	let detail = `HTTP ${res.status}`;
	if (certProbe) {
		const cert = await certProbe;
		if (cert) {
			certDays = cert.daysRemaining;
			detail += ` · cert ${certDays}d`;
		}
	}

	const warnDays = service.cert_warn_days ?? ctx.certWarnDays;
	const certSoon = certDays !== undefined && certDays <= warnDays;

	return {
		ok: true,
		degraded: latencyMs > ctx.degradedMs || certSoon,
		latencyMs,
		detail,
		certDays
	};
}

async function readBounded(res: Response, max: number): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) return res.text();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			total += value.byteLength;
			if (total > max) break;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(Math.min(total, 1024 * 1024));
	let off = 0;
	for (const c of chunks) {
		const slice = c.subarray(0, Math.min(c.byteLength, out.byteLength - off));
		out.set(slice, off);
		off += slice.byteLength;
		if (off >= out.byteLength) break;
	}
	return out;
}

/** Plain TCP connect; resolves to the latency in ms or null on failure. */
function tryTcp(
	host: string,
	port: number,
	timeoutMs: number,
	lookup?: Egress['lookup']
): Promise<number | null> {
	return new Promise((resolve) => {
		const started = performance.now();
		const socket = connect({ host, port, ...(lookup ? { lookup } : {}) });
		const finish = (latency: number | null) => {
			socket.destroy();
			resolve(latency);
		};
		socket.setTimeout(timeoutMs);
		socket.once('connect', () => {
			finish(performance.now() - started);
		});
		socket.once('timeout', () => {
			finish(null);
		});
		socket.once('error', () => {
			finish(null);
		});
	});
}

async function checkTcp(
	service: Extract<ServiceConfig, { type: 'tcp' }>,
	ctx: CheckContext
): Promise<CheckOutcome> {
	if (service.tls) {
		const started = performance.now();
		const cert = await probeCert(
			service.host,
			service.port,
			ctx.timeoutMs,
			service.host,
			ctx.egress.lookup
		);
		const latencyMs = performance.now() - started;
		if (!cert) {
			return { ok: false, degraded: false, latencyMs, detail: 'TLS handshake failed' };
		}
		if (!cert.authorized) {
			return {
				ok: false,
				degraded: false,
				latencyMs,
				certDays: cert.daysRemaining,
				detail: 'TLS certificate not trusted'
			};
		}
		const warnDays = service.cert_warn_days ?? ctx.certWarnDays;
		return {
			ok: true,
			degraded: latencyMs > ctx.degradedMs || cert.daysRemaining <= warnDays,
			latencyMs,
			detail: `TLS :${service.port} · cert ${cert.daysRemaining}d`,
			certDays: cert.daysRemaining
		};
	}

	const latency = await tryTcp(service.host, service.port, ctx.timeoutMs, ctx.egress.lookup);
	if (latency === null) {
		return {
			ok: false,
			degraded: false,
			latencyMs: ctx.timeoutMs,
			detail: 'connect failed or timed out'
		};
	}
	return {
		ok: true,
		degraded: latency > ctx.degradedMs,
		latencyMs: latency,
		detail: `connected :${service.port}`
	};
}

async function checkPing(
	service: Extract<ServiceConfig, { type: 'ping' }>,
	ctx: CheckContext
): Promise<CheckOutcome> {
	const started = performance.now();
	const perPort = Math.max(500, Math.floor(ctx.timeoutMs / service.ports.length));
	const results = await Promise.all(
		service.ports.map((p) => tryTcp(service.host, p, perPort, ctx.egress.lookup))
	);
	const open = service.ports.filter((_, i) => results[i] !== null);
	const latencyMs = performance.now() - started;

	if (open.length === 0) {
		return {
			ok: false,
			degraded: false,
			latencyMs,
			detail: `no probe port reachable (${service.ports.join(', ')})`
		};
	}
	return {
		ok: true,
		degraded: latencyMs > ctx.degradedMs,
		latencyMs,
		detail: `reachable via :${open.join(', :')}`
	};
}

async function checkDns(
	service: Extract<ServiceConfig, { type: 'dns' }>,
	ctx: CheckContext
): Promise<CheckOutcome> {
	const started = performance.now();
	const resolver = new Resolver({ timeout: ctx.timeoutMs, tries: 1 });
	const records = await resolver.resolve(service.host, service.record_type);
	const latencyMs = performance.now() - started;
	const count = Array.isArray(records) ? records.length : 0;
	if (count === 0) {
		return { ok: false, degraded: false, latencyMs, detail: `no ${service.record_type} records` };
	}
	return {
		ok: true,
		degraded: latencyMs > ctx.degradedMs,
		latencyMs,
		detail: `${count} ${service.record_type} record${count === 1 ? '' : 's'}`
	};
}

// UDP has no lookup hook, so hostnames are resolved through the
// guarded egress lookup first and the datagram goes to the literal IP.
async function guardedResolve(host: string, ctx: CheckContext): Promise<string> {
	if (isIP(host) !== 0) return host;
	return new Promise((resolve, reject) => {
		ctx.egress.lookup(host, {}, (err, address) => {
			if (err) reject(err);
			else resolve(Array.isArray(address) ? (address[0]?.address ?? host) : address);
		});
	});
}

// A2S_INFO: FFFFFFFF 'T' "Source Engine Query" 0x00. Some servers
// answer with a challenge ('A' + int32) that must be echoed back.
const A2S_INFO_REQ = Buffer.concat([
	Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
	Buffer.from('Source Engine Query\0', 'latin1')
]);

interface A2sInfo {
	name: string;
	map: string;
	players: number;
	maxPlayers: number;
}

function a2sQuery(ip: string, port: number, timeoutMs: number): Promise<A2sInfo> {
	return new Promise((resolve, reject) => {
		const socket = createSocket('udp4');
		const timer = setTimeout(() => {
			socket.close();
			reject(new Error('timeout'));
		}, timeoutMs);
		const fail = (e: Error) => {
			clearTimeout(timer);
			socket.close();
			reject(e);
		};
		const send = (challenge?: Buffer) => {
			const packet = challenge ? Buffer.concat([A2S_INFO_REQ, challenge]) : A2S_INFO_REQ;
			socket.send(packet, port, ip, (err) => {
				if (err) fail(err);
			});
		};
		socket.once('error', fail);
		socket.on('message', (msg) => {
			if (msg.length < 5 || msg.readUInt32LE(0) !== 0xffffffff) return;
			const kind = msg.readUInt8(4);
			if (kind === 0x41 && msg.length >= 9) {
				// Challenge response: resend with the echoed token.
				send(msg.subarray(5, 9));
				return;
			}
			if (kind !== 0x49) return;
			try {
				let off = 6; // skip header + protocol byte
				const zstr = () => {
					const end = msg.indexOf(0, off);
					const s = msg.toString('latin1', off, end < 0 ? msg.length : end);
					off = (end < 0 ? msg.length : end) + 1;
					return s;
				};
				const name = zstr();
				const map = zstr();
				zstr(); // folder
				zstr(); // game
				off += 2; // app id
				const players = msg.readUInt8(off);
				const maxPlayers = msg.readUInt8(off + 1);
				clearTimeout(timer);
				socket.close();
				resolve({ name, map, players, maxPlayers });
			} catch (e) {
				fail(e instanceof Error ? e : new Error('bad A2S reply'));
			}
		});
		send();
	});
}

async function checkA2s(
	service: Extract<ServiceConfig, { type: 'a2s' }>,
	ctx: CheckContext
): Promise<CheckOutcome> {
	if (!ctx.egress.allowLinkLocal() && blockedHost(service.host)) {
		return { ok: false, degraded: false, latencyMs: 0, detail: EGRESS_BLOCKED_DETAIL };
	}
	const started = performance.now();
	const ip = await guardedResolve(service.host, ctx);
	const info = await a2sQuery(ip, service.port, ctx.timeoutMs);
	const latencyMs = performance.now() - started;
	const name = info.name || 'unnamed';
	return {
		ok: true,
		degraded: latencyMs > ctx.degradedMs,
		latencyMs,
		detail: `${name} · ${info.players}/${info.maxPlayers} on ${info.map}`
	};
}

// Dot-path resolver for json checks: a.b.0.c walks objects and arrays.
function resolvePath(doc: unknown, path: string): { found: boolean; value: unknown } {
	let cur = doc;
	for (const seg of path.split('.')) {
		if (cur === null || typeof cur !== 'object') return { found: false, value: undefined };
		if (Array.isArray(cur)) {
			const i = Number(seg);
			if (!Number.isInteger(i) || i < 0 || i >= cur.length) {
				return { found: false, value: undefined };
			}
			cur = cur[i];
		} else {
			if (!(seg in cur)) return { found: false, value: undefined };
			cur = (cur as Record<string, unknown>)[seg];
		}
	}
	return { found: true, value: cur };
}

async function checkJson(
	service: Extract<ServiceConfig, { type: 'json' }>,
	ctx: CheckContext
): Promise<CheckOutcome> {
	const url = new URL(service.url);
	if (!ctx.egress.allowLinkLocal() && blockedHost(url.hostname)) {
		return { ok: false, degraded: false, latencyMs: 0, detail: EGRESS_BLOCKED_DETAIL };
	}
	const started = performance.now();
	const res = await fetch(service.url, {
		method: 'GET',
		redirect: 'manual',
		dispatcher: ctx.egress.dispatcher,
		signal: AbortSignal.timeout(ctx.timeoutMs),
		headers: {
			'user-agent': ctx.userAgent,
			accept: 'application/json',
			...service.headers
		}
	} as FetchInit);
	const latencyMs = performance.now() - started;

	if (!service.expected_statuses.includes(res.status)) {
		return {
			ok: false,
			degraded: false,
			latencyMs,
			detail: `unexpected status ${res.status}`
		};
	}
	const body = await readBounded(res, MAX_BODY_BYTES);
	let doc: unknown;
	try {
		doc = JSON.parse(body);
	} catch {
		return { ok: false, degraded: false, latencyMs, detail: 'response is not JSON' };
	}
	const { found, value } = resolvePath(doc, service.json_path);
	if (!found) {
		return {
			ok: false,
			degraded: false,
			latencyMs,
			detail: `path ${service.json_path} not found`
		};
	}
	if (service.json_value !== undefined) {
		if (String(value) !== service.json_value) {
			return {
				ok: false,
				degraded: false,
				latencyMs,
				detail: `${service.json_path} = ${JSON.stringify(value)} (want ${service.json_value})`
			};
		}
		return {
			ok: true,
			degraded: latencyMs > ctx.degradedMs,
			latencyMs,
			detail: `${service.json_path} = ${service.json_value}`
		};
	}
	if (!value) {
		return {
			ok: false,
			degraded: false,
			latencyMs,
			detail: `${service.json_path} is falsy`
		};
	}
	return {
		ok: true,
		degraded: latencyMs > ctx.degradedMs,
		latencyMs,
		detail: `${service.json_path} present`
	};
}

// Small TCP conversations: connects through the guarded egress lookup
// (DNS-rebinding safe), feeds inbound bytes to inspect until it returns
// a verdict, and bounds the exchange by timeout and byte cap.
const MAX_PROBE_BYTES = 64 * 1024;

interface ProbeResult {
	ok: boolean;
	detail: string;
}

function socketProbe<T>(
	socket: Socket,
	readyEvent: 'connect' | 'secureConnect',
	ctx: CheckContext,
	inspect: (buf: Buffer, socket: Socket) => T | null,
	onReady?: (socket: Socket) => void
): Promise<T> {
	return new Promise((resolve, reject) => {
		let buf = Buffer.alloc(0);
		let settled = false;
		const done = (err: Error | null, value?: T) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (err) reject(err);
			else resolve(value as T);
		};
		const timer = setTimeout(() => {
			done(new Error('timeout'));
		}, ctx.timeoutMs);
		socket.once(readyEvent, () => {
			try {
				onReady?.(socket);
			} catch (e) {
				done(e instanceof Error ? e : new Error('write failed'));
			}
		});
		socket.on('data', (chunk: Buffer) => {
			if (settled) return;
			buf = Buffer.concat([buf, chunk]);
			if (buf.length > MAX_PROBE_BYTES) {
				done(new Error('oversized reply'));
				return;
			}
			let r: T | null;
			try {
				r = inspect(buf, socket);
			} catch {
				done(new Error('bad reply'));
				return;
			}
			if (r !== null) done(null, r);
		});
		socket.once('error', (e) => {
			done(e);
		});
		socket.once('end', () => {
			done(new Error('connection closed'));
		});
	});
}

function tcpProbe<T>(
	host: string,
	port: number,
	ctx: CheckContext,
	inspect: (buf: Buffer, socket: Socket) => T | null,
	onConnect?: (socket: Socket) => void
): Promise<T> {
	const socket = connect({ host, port, lookup: ctx.egress.lookup });
	return socketProbe(socket, 'connect', ctx, inspect, onConnect);
}

function probeOutcome(r: ProbeResult, latencyMs: number, ctx: CheckContext): CheckOutcome {
	return { ok: r.ok, degraded: r.ok && latencyMs > ctx.degradedMs, latencyMs, detail: r.detail };
}

function blocked(): CheckOutcome {
	return { ok: false, degraded: false, latencyMs: 0, detail: EGRESS_BLOCKED_DETAIL };
}

// Postgres StartupMessage: length + protocol 3.0 + key/value cstrings
// + terminator. user defaults to 'monitor'; database optional.
export function pgStartup(user: string, database?: string): Buffer {
	const keys = ['user', user];
	if (database) keys.push('database', database);
	const body = Buffer.concat([
		Buffer.from([0x00, 0x03, 0x00, 0x00]),
		Buffer.from(`${keys.join('\0')}\0\0`, 'utf8')
	]);
	const head = Buffer.alloc(4);
	head.writeUInt32BE(body.length + 4);
	return Buffer.concat([head, body]);
}

// First backend message is a type byte + int32 length. 'R' auth
// requests, 'E' errors, 'N' notices and 'v' protocol negotiation all
// prove a Postgres peer; anything else is not Postgres.
const PG_OK_TYPES = new Set(['R', 'E', 'N', 'v']);

export function pgReply(buf: Buffer): ProbeResult | null {
	if (buf.length < 5) return null;
	const len = buf.readUInt32BE(1);
	if (len < 4 || len > MAX_PROBE_BYTES) return { ok: false, detail: 'malformed reply' };
	const type = String.fromCharCode(buf.readUInt8(0));
	if (!PG_OK_TYPES.has(type)) {
		return { ok: false, detail: `unexpected reply 0x${buf.readUInt8(0).toString(16)}` };
	}
	if (type === 'E') {
		const msg = pgErrorMessage(buf);
		return { ok: true, detail: msg ? `postgres error: ${msg}` : 'postgres protocol ok' };
	}
	return { ok: true, detail: 'postgres protocol ok' };
}

// ErrorResponse fields are code byte + cstring pairs, 0-terminated.
// 'M' carries the human readable message.
function pgErrorMessage(buf: Buffer): string | undefined {
	let off = 5;
	while (off < buf.length && buf.readUInt8(off) !== 0) {
		const code = buf.readUInt8(off);
		const end = buf.indexOf(0, off + 1);
		if (end < 0) return undefined;
		if (code === 0x4d) return buf.toString('utf8', off + 1, end).slice(0, 120);
		off = end + 1;
	}
	return undefined;
}

async function checkPostgres(
	service: Extract<ServiceConfig, { type: 'postgres' }>,
	ctx: CheckContext
): Promise<CheckOutcome> {
	if (!ctx.egress.allowLinkLocal() && blockedHost(service.host)) return blocked();
	const started = performance.now();
	const r = await tcpProbe(service.host, service.port, ctx, pgReply, (s) =>
		s.write(pgStartup(service.user ?? 'monitor', service.database))
	);
	return probeOutcome(r, performance.now() - started, ctx);
}

// MySQL handshake: 3-byte payload length + seq + payload. Payload[0]
// is the protocol version (10); a 0xff ERR packet also proves a live
// MySQL peer (e.g. host blocked from connecting).
export function mysqlHandshake(buf: Buffer): ProbeResult | null {
	if (buf.length < 5) return null;
	const payloadLen = buf.readUIntLE(0, 3);
	if (payloadLen < 1 || payloadLen > MAX_PROBE_BYTES) {
		return { ok: false, detail: 'malformed handshake' };
	}
	const proto = buf.readUInt8(4);
	if (proto === 0xff) return { ok: true, detail: 'mysql error reply (alive)' };
	if (proto !== 9 && proto !== 10) {
		return { ok: false, detail: `unexpected reply 0x${proto.toString(16)}` };
	}
	const end = buf.indexOf(0, 5);
	const version =
		end > 5 ? buf.toString('utf8', 5, Math.min(end, 4 + payloadLen)).slice(0, 60) : '';
	return { ok: true, detail: version ? `mysql ${version}` : 'mysql handshake ok' };
}

async function checkMysql(
	service: Extract<ServiceConfig, { type: 'mysql' }>,
	ctx: CheckContext
): Promise<CheckOutcome> {
	if (!ctx.egress.allowLinkLocal() && blockedHost(service.host)) return blocked();
	const started = performance.now();
	const r = await tcpProbe(service.host, service.port, ctx, mysqlHandshake);
	return probeOutcome(r, performance.now() - started, ctx);
}

// RESP simple strings (+) and errors (-) both prove a Redis peer;
// -NOAUTH in particular means auth-gated but alive.
export function redisReply(buf: Buffer): ProbeResult | null {
	if (buf.length < 1) return null;
	const kind = buf.readUInt8(0);
	if (kind !== 0x2b && kind !== 0x2d) {
		return { ok: false, detail: `unexpected reply 0x${kind.toString(16)}` };
	}
	const end = buf.indexOf('\r\n');
	if (end < 0) return null;
	return { ok: true, detail: `redis ${buf.toString('utf8', 0, Math.min(end, 200))}` };
}

async function checkRedis(
	service: Extract<ServiceConfig, { type: 'redis' }>,
	ctx: CheckContext
): Promise<CheckOutcome> {
	if (!ctx.egress.allowLinkLocal() && blockedHost(service.host)) return blocked();
	const started = performance.now();
	const r = await tcpProbe(service.host, service.port, ctx, redisReply, (s) => s.write('PING\r\n'));
	return probeOutcome(r, performance.now() - started, ctx);
}

// RDAP bootstrap: the IANA registry maps TLDs to base URLs. Cached in
// memory for a day; com/net fall back to Verisign when the bootstrap
// is unreachable or lacks the TLD.
const RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const RDAP_BOOTSTRAP_TTL_MS = 24 * 3600_000;
const RDAP_FALLBACK: Record<string, string> = {
	com: 'https://rdap.verisign.com/com/v1/',
	net: 'https://rdap.verisign.com/net/v1/'
};
let rdapBootstrap: { fetchedAt: number; doc: unknown } | null = null;

export function rdapBaseFor(bootstrap: unknown, tld: string): string | null {
	const services = (bootstrap as { services?: unknown } | null)?.services;
	if (!Array.isArray(services)) return null;
	for (const entry of services) {
		if (!Array.isArray(entry)) continue;
		const [tlds, urls] = entry as unknown[];
		if (!Array.isArray(tlds) || !Array.isArray(urls) || !tlds.includes(tld)) continue;
		const base: unknown = urls.find((u) => typeof u === 'string' && u.startsWith('https://'));
		if (typeof base === 'string') return base.endsWith('/') ? base : `${base}/`;
	}
	return null;
}

async function loadRdapBootstrap(ctx: CheckContext): Promise<unknown> {
	if (rdapBootstrap && Date.now() - rdapBootstrap.fetchedAt < RDAP_BOOTSTRAP_TTL_MS) {
		return rdapBootstrap.doc;
	}
	try {
		const res = await fetch(RDAP_BOOTSTRAP_URL, {
			dispatcher: ctx.egress.dispatcher,
			signal: AbortSignal.timeout(ctx.timeoutMs),
			headers: { 'user-agent': ctx.userAgent, accept: 'application/json' }
		} as FetchInit);
		const doc: unknown = res.ok ? await res.json() : null;
		if (doc) rdapBootstrap = { fetchedAt: Date.now(), doc };
		return doc ?? rdapBootstrap?.doc ?? null;
	} catch {
		return rdapBootstrap?.doc ?? null;
	}
}

// The registration expiry lives in events[] as eventAction
// 'expiration' + eventDate. Match loosely: registries also emit
// 'expiry' and 'expiration date'.
export function rdapExpiry(doc: unknown): number | null {
	const events = (doc as { events?: unknown } | null)?.events;
	if (!Array.isArray(events)) return null;
	for (const e of events) {
		const action = (e as { eventAction?: unknown } | null)?.eventAction;
		const date = (e as { eventDate?: unknown } | null)?.eventDate;
		if (typeof action !== 'string' || typeof date !== 'string') continue;
		if (!action.toLowerCase().includes('expir')) continue;
		const t = Date.parse(date);
		if (!Number.isNaN(t)) return t;
	}
	return null;
}

async function checkRdap(
	service: Extract<ServiceConfig, { type: 'rdap' }>,
	ctx: CheckContext
): Promise<CheckOutcome> {
	const domain = service.domain.toLowerCase();
	const tld = domain.split('.').pop() ?? '';
	const started = performance.now();
	const bootstrap = await loadRdapBootstrap(ctx);
	const base = rdapBaseFor(bootstrap, tld) ?? RDAP_FALLBACK[tld];
	if (!base) {
		return {
			ok: false,
			degraded: false,
			latencyMs: performance.now() - started,
			detail: `no rdap server for .${tld}`
		};
	}
	if (!ctx.egress.allowLinkLocal() && blockedHost(new URL(base).hostname)) return blocked();
	const res = await fetch(`${base}domain/${encodeURIComponent(domain)}`, {
		dispatcher: ctx.egress.dispatcher,
		redirect: 'follow',
		signal: AbortSignal.timeout(ctx.timeoutMs),
		headers: {
			'user-agent': ctx.userAgent,
			accept: 'application/rdap+json, application/json'
		}
	} as FetchInit);
	const latencyMs = performance.now() - started;
	if (!res.ok) {
		return {
			ok: false,
			degraded: false,
			latencyMs,
			detail: res.status === 404 ? 'domain not found' : `rdap ${res.status}`
		};
	}
	const body = await readBounded(res, MAX_BODY_BYTES);
	let doc: unknown;
	try {
		doc = JSON.parse(body);
	} catch {
		return { ok: false, degraded: false, latencyMs, detail: 'rdap reply is not JSON' };
	}
	const expiry = rdapExpiry(doc);
	if (expiry === null) {
		return { ok: false, degraded: false, latencyMs, detail: 'no expiration event' };
	}
	const days = Math.floor((expiry - Date.now()) / 86_400_000);
	if (days < 0) {
		return { ok: false, degraded: false, latencyMs, detail: `expired ${-days}d ago` };
	}
	return {
		ok: true,
		degraded: latencyMs > ctx.degradedMs || days <= service.warn_days,
		latencyMs,
		detail: `expires in ${days}d`
	};
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_MAX_HEADER_BYTES = 16 * 1024;

export function wsAccept(key: string): string {
	return createHash('sha1')
		.update(key + WS_GUID)
		.digest('base64');
}

// Upgrade response: status line must be 101 and Sec-WebSocket-Accept
// must echo sha1(key + GUID), else the peer is not a real websocket.
export function wsHandshakeReply(buf: Buffer, key: string): ProbeResult | null {
	const end = buf.indexOf('\r\n\r\n');
	if (end < 0) {
		return buf.length > WS_MAX_HEADER_BYTES ? { ok: false, detail: 'oversized headers' } : null;
	}
	const head = buf.toString('latin1', 0, end);
	const status = head.split('\r\n', 1)[0] ?? '';
	const code = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(status)?.[1];
	if (code !== '101') {
		return { ok: false, detail: `unexpected status ${code ?? status.slice(0, 40)}` };
	}
	const accept = /^sec-websocket-accept:\s*(\S+)\s*$/im.exec(head)?.[1];
	if (accept !== wsAccept(key)) return { ok: false, detail: 'bad Sec-WebSocket-Accept' };
	return { ok: true, detail: 'websocket upgrade ok' };
}

async function checkWebsocket(
	service: Extract<ServiceConfig, { type: 'websocket' }>,
	ctx: CheckContext
): Promise<CheckOutcome> {
	const url = new URL(service.url);
	if (!ctx.egress.allowLinkLocal() && blockedHost(url.hostname)) return blocked();
	const secure = url.protocol === 'wss:';
	const port = url.port ? Number(url.port) : secure ? 443 : 80;
	const key = randomBytes(16).toString('base64');
	const req =
		`GET ${url.pathname || '/'}${url.search} HTTP/1.1\r\n` +
		`Host: ${url.host}\r\n` +
		'Upgrade: websocket\r\n' +
		'Connection: Upgrade\r\n' +
		`Sec-WebSocket-Key: ${key}\r\n` +
		'Sec-WebSocket-Version: 13\r\n' +
		`User-Agent: ${ctx.userAgent}\r\n\r\n`;
	const started = performance.now();
	// tls.connect forwards lookup to the inner net.connect, so the same
	// guarded resolution applies to wss.
	const socket = secure
		? tlsConnect({ host: url.hostname, port, servername: url.hostname, lookup: ctx.egress.lookup })
		: connect({ host: url.hostname, port, lookup: ctx.egress.lookup });
	const r = await socketProbe(
		socket,
		secure ? 'secureConnect' : 'connect',
		ctx,
		(buf) => wsHandshakeReply(buf, key),
		(s) => s.write(req)
	);
	return probeOutcome(r, performance.now() - started, ctx);
}

// Security header posture for the domain composite: six presence
// checks where the CSP frame-ancestors directive also counts as frame
// protection in place of x-frame-options.
export function headerScore(headers: Headers): number {
	const csp = headers.get('content-security-policy') ?? '';
	const checks = [
		headers.get('strict-transport-security') !== null,
		csp !== '',
		headers.get('x-frame-options') !== null || /frame-ancestors/i.test(csp),
		headers.get('x-content-type-options') !== null,
		headers.get('referrer-policy') !== null,
		headers.get('permissions-policy') !== null
	];
	return checks.filter(Boolean).length;
}

// TLSA records as returned by Resolver.resolveTlsa; data arrives as an
// ArrayBuffer of association bytes.
export interface TlsaRecordLike {
	certUsage: number;
	selector: number;
	match: number;
	data: ArrayBuffer | Uint8Array;
}

// RFC 6698 matching. Only usage 3 (DANE-EE) is validated against the
// leaf cert; selector 0 hashes the whole cert DER, selector 1 the
// SubjectPublicKeyInfo. Any matching usage-3 record wins; evaluated
// records that all miss are a mismatch; records we cannot evaluate
// (other usages, selector 1 without an SPKI, unknown match type) are
// reported as unvalidated.
export function tlsaMatch(
	records: TlsaRecordLike[],
	certDer: Buffer | null,
	spki: Buffer | null
): 'match' | 'mismatch' | 'unvalidated' | null {
	if (records.length === 0) return null;
	let evaluated = 0;
	for (const r of records) {
		if (r.certUsage !== 3) continue;
		const src = r.selector === 0 ? certDer : r.selector === 1 ? spki : null;
		if (!src || src.length === 0) continue;
		const digest =
			r.match === 0
				? src
				: r.match === 1
					? createHash('sha256').update(src).digest()
					: r.match === 2
						? createHash('sha512').update(src).digest()
						: null;
		if (!digest) continue;
		evaluated++;
		const want = Buffer.from(r.data instanceof Uint8Array ? r.data : new Uint8Array(r.data));
		if (digest.equals(want)) return 'match';
	}
	return evaluated > 0 ? 'mismatch' : 'unvalidated';
}

// GET https://<domain>/ and score the response headers. A fetch
// failure yields null so the caller can degrade without failing the
// whole check (the domain may legitimately be plain http).
async function fetchHeaderScore(domain: string, ctx: CheckContext): Promise<number | null> {
	try {
		const res = await fetch(`https://${domain}/`, {
			redirect: 'follow',
			dispatcher: ctx.egress.dispatcher,
			signal: AbortSignal.timeout(ctx.timeoutMs),
			headers: { 'user-agent': ctx.userAgent, accept: 'text/html, */*' }
		} as FetchInit);
		// Drain so the socket can be reused.
		await res.arrayBuffer().catch(() => undefined);
		return headerScore(res.headers);
	} catch {
		return null;
	}
}

// Domain health composite: DNS is the only hard failure (a name that
// resolves to nothing has nothing left to probe); every other signal
// degrades. Sub-probes run concurrently, each bounded by its own
// timeout so the whole check stays inside ctx.timeoutMs.
async function checkDomain(
	service: Extract<ServiceConfig, { type: 'domain' }>,
	ctx: CheckContext
): Promise<CheckOutcome> {
	if (!ctx.egress.allowLinkLocal() && blockedHost(service.domain)) return blocked();
	const domain = service.domain.toLowerCase();
	const started = performance.now();
	const resolver = new Resolver({ timeout: ctx.timeoutMs, tries: 1 });
	const countOf = (p: Promise<unknown>) =>
		p.then((r) => (Array.isArray(r) ? r.length : 0)).catch(() => 0);

	const [a4, a6] = await Promise.all([
		resolver.resolve4(domain).catch(() => [] as string[]),
		resolver.resolve6(domain).catch(() => [] as string[])
	]);
	if (a4.length === 0 && a6.length === 0) {
		return {
			ok: false,
			degraded: false,
			latencyMs: performance.now() - started,
			detail: 'no A/AAAA records'
		};
	}
	const notes = [`A ${a4.length} AAAA ${a6.length}`];

	const extras = Promise.all([
		countOf(resolver.resolveMx(domain)),
		countOf(resolver.resolveNs(domain)),
		countOf(resolver.resolveCaa(domain))
	]);
	const certP = service.tls
		? probeCert(domain, 443, ctx.timeoutMs, domain, ctx.egress.lookup)
		: Promise.resolve(null);
	const headersP = service.headers ? fetchHeaderScore(domain, ctx) : Promise.resolve(null);
	const tlsaP = service.dane
		? resolver.resolveTlsa(`_443._tcp.${domain}`).catch(() => [])
		: Promise.resolve([]);
	const perPort = Math.max(500, Math.floor(ctx.timeoutMs / service.ports.length));
	const portsP =
		service.ports.length > 0
			? Promise.all(service.ports.map((p) => tryTcp(domain, p, perPort, ctx.egress.lookup)))
			: Promise.resolve([]);

	const [extra, cert, score, tlsa, ports] = await Promise.all([
		extras,
		certP,
		headersP,
		tlsaP,
		portsP
	]);

	let degraded = false;
	let certDays: number | undefined;
	const [mx, ns, caa] = extra;
	if (mx > 0) notes.push(`MX ${mx}`);
	if (ns > 0) notes.push(`NS ${ns}`);
	if (caa > 0) notes.push(`CAA ${caa}`);

	if (service.tls) {
		if (cert === null) {
			degraded = true;
			notes.push('cert probe failed');
		} else {
			certDays = cert.daysRemaining;
			notes.push(`cert ${certDays}d`);
			const warnDays = service.cert_warn_days ?? ctx.certWarnDays;
			if (!cert.authorized || certDays <= warnDays) degraded = true;
		}
	}

	if (service.headers) {
		if (score === null) {
			degraded = true;
			notes.push('headers fetch failed');
		} else {
			notes.push(`headers ${score}/6`);
			if (score < 4) degraded = true;
		}
	}

	if (service.dane) {
		if (tlsa.length === 0) {
			notes.push('no TLSA');
		} else {
			const verdict = tlsaMatch(tlsa, cert?.derCert ?? null, cert?.spki ?? null);
			if (verdict === 'match') {
				notes.push('dane ok');
			} else if (verdict === 'mismatch') {
				degraded = true;
				notes.push('DANE mismatch');
			} else {
				notes.push(`dane usage ${tlsa[0].certUsage} (unvalidated)`);
			}
		}
	}

	if (service.ports.length > 0) {
		const open = service.ports.filter((_, i) => ports[i] !== null);
		notes.push(open.length > 0 ? `open ${open.join(', ')}` : 'no ports open');
		const expected = service.expected_open;
		if (expected) {
			const stray = open.filter((p) => !expected.includes(p));
			if (stray.length > 0) {
				degraded = true;
				notes.push(`unexpected open ${stray.join(', ')}`);
			}
		}
	}

	const latencyMs = performance.now() - started;
	return {
		ok: true,
		degraded: degraded || latencyMs > ctx.degradedMs,
		latencyMs,
		detail: notes.join(' · '),
		certDays
	};
}

function xmlEscape(s: string): string {
	return s
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

// XMPP c2s: after our <stream:stream> the server answers with its own
// stream header plus <stream:features>; <stream:error> or an immediate
// close fails the probe. Anything that is not XML is not XMPP.
export function xmppStreamReply(buf: Buffer): ProbeResult | null {
	const head = buf.toString('latin1', 0, Math.min(buf.length, 16384)).trimStart();
	if (!head.startsWith('<?xml') && !head.startsWith('<stream')) {
		return { ok: false, detail: 'not an xmpp stream' };
	}
	if (head.includes('<stream:error')) return { ok: false, detail: 'stream error' };
	if (head.includes('</stream:stream>')) return { ok: false, detail: 'stream closed' };
	if (!head.includes('<stream:features')) return null;
	const features: string[] = [];
	if (/<starttls[\s/>]/.test(head)) features.push('starttls');
	if (/<mechanisms[\s>]/.test(head)) features.push('sasl');
	if (/<bind[\s/>]/.test(head)) features.push('bind');
	if (/<register[\s/>]/.test(head)) features.push('inband-reg');
	const extra = features.length > 0 ? ` (${features.join(', ')})` : '';
	return { ok: true, detail: `xmpp stream ok${extra}` };
}

// Cert info captured inside a secureConnect callback, where the TLS
// socket already has the peer certificate.
function socketCertDays(socket: Socket): { days: number; authorized: boolean } | null {
	const cert = (socket as TLSSocket).getPeerCertificate();
	const validTo = cert.valid_to ? Date.parse(cert.valid_to) : NaN;
	if (Number.isNaN(validTo)) return null;
	return { days: daysUntil(validTo), authorized: (socket as TLSSocket).authorized };
}

// Fold a captured cert into the outcome: degrades on an untrusted
// chain or expiry inside the warn window.
function applyCert(
	out: CheckOutcome,
	cert: { days: number; authorized: boolean } | null,
	service: { cert_warn_days?: number },
	ctx: CheckContext
): CheckOutcome {
	if (cert === null) return out;
	const warnDays = service.cert_warn_days ?? ctx.certWarnDays;
	return {
		...out,
		degraded: out.degraded || !cert.authorized || cert.days <= warnDays,
		detail: `${out.detail} · cert ${cert.days}d`,
		certDays: cert.days
	};
}

async function checkXmpp(
	service: Extract<ServiceConfig, { type: 'xmpp' }>,
	ctx: CheckContext
): Promise<CheckOutcome> {
	if (!ctx.egress.allowLinkLocal() && blockedHost(service.host)) return blocked();
	const domain = service.domain ?? service.host;
	const hello =
		`<?xml version='1.0'?><stream:stream to='${xmlEscape(domain)}' ` +
		`xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>`;
	const started = performance.now();
	let cert: { days: number; authorized: boolean } | null = null;
	// tls.connect forwards lookup to the inner net.connect, so the same
	// guarded resolution applies to direct TLS.
	const socket = service.tls
		? tlsConnect({
				host: service.host,
				port: service.port,
				servername: domain,
				lookup: ctx.egress.lookup
			})
		: connect({ host: service.host, port: service.port, lookup: ctx.egress.lookup });
	const r = await socketProbe(
		socket,
		service.tls ? 'secureConnect' : 'connect',
		ctx,
		xmppStreamReply,
		(s) => {
			if (service.tls) cert = socketCertDays(s);
			s.write(hello);
		}
	);
	const out = probeOutcome(r, performance.now() - started, ctx);
	return service.tls ? applyCert(out, cert, service, ctx) : out;
}

// IRC numerics: 001 RPL_WELCOME completes registration; 433
// nick-in-use still proves a live IRCd. ERROR, 464 (bad password) and
// 465 (banned) fail the probe. Server lines begin with ':', PING,
// ERROR, NOTICE or AUTHENTICATE; anything else is not IRC.
export function ircReply(buf: Buffer): ProbeResult | null {
	const text = buf.toString('latin1');
	const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
	const tail = text.endsWith('\n') ? '' : (lines.pop() ?? '');
	for (const line of lines) {
		if (line === '') continue;
		if (!/^[:PENA]/.test(line)) return { ok: false, detail: 'unexpected reply' };
		if (line.startsWith('ERROR')) {
			return { ok: false, detail: line.slice(5).trim().slice(0, 120) || 'irc error' };
		}
		const m = /^:([^ ]+) (\d{3}) \S+ ?(.*)$/.exec(line);
		if (!m) continue;
		if (m[2] === '001') return { ok: true, detail: `irc ${m[1]} welcome` };
		if (m[2] === '433') return { ok: true, detail: 'irc alive (nick in use)' };
		if (m[2] === '464' || m[2] === '465') {
			return { ok: false, detail: `irc rejected (${m[3].slice(0, 80) || 'auth/ban'})` };
		}
	}
	// An unterminated tail still fails fast when it cannot be an irc
	// line prefix.
	if (tail !== '' && !/^[:PENA]/.test(tail)) return { ok: false, detail: 'unexpected reply' };
	return null;
}

// PING tokens the server has sent so far; the checker echoes them back
// as PONG so registration is not dropped mid-handshake.
export function ircPings(buf: Buffer): string[] {
	const out: string[] = [];
	for (const line of buf.toString('latin1').split('\n')) {
		const m = /^PING :?([^\s]+)\s*$/.exec(line.trimEnd());
		if (m) out.push(m[1]);
	}
	return out;
}

async function checkIrc(
	service: Extract<ServiceConfig, { type: 'irc' }>,
	ctx: CheckContext
): Promise<CheckOutcome> {
	if (!ctx.egress.allowLinkLocal() && blockedHost(service.host)) return blocked();
	const nick = service.nick ?? `stat${randomBytes(3).toString('hex')}`;
	const ponged = new Set<string>();
	const started = performance.now();
	let cert: { days: number; authorized: boolean } | null = null;
	const socket = service.tls
		? tlsConnect({
				host: service.host,
				port: service.port,
				servername: service.host,
				lookup: ctx.egress.lookup
			})
		: connect({ host: service.host, port: service.port, lookup: ctx.egress.lookup });
	const r = await socketProbe(
		socket,
		service.tls ? 'secureConnect' : 'connect',
		ctx,
		(buf, s) => {
			for (const token of ircPings(buf)) {
				if (ponged.has(token)) continue;
				ponged.add(token);
				s.write(`PONG :${token}\r\n`);
			}
			return ircReply(buf);
		},
		(s) => {
			if (service.tls) cert = socketCertDays(s);
			s.write(`NICK ${nick}\r\nUSER ${nick} 0 * :status monitor\r\n`);
		}
	);
	const out = probeOutcome(r, performance.now() - started, ctx);
	return service.tls ? applyCert(out, cert, service, ctx) : out;
}

// Push services never connect anywhere; the "check" is whether a beat
// arrived inside expected_interval + grace. A never-beaten service is
// degraded (unverified), not a hard outage.
function checkPush(
	service: Extract<ServiceConfig, { type: 'push' }>,
	ctx: CheckContext
): CheckOutcome {
	const last = ctx.lastBeat?.(service.id) ?? null;
	if (last === null) {
		return { ok: true, degraded: true, latencyMs: 0, detail: 'awaiting first check-in' };
	}
	const deadline = last + (service.expected_interval_seconds + service.grace_seconds) * 1000;
	const lateSec = Math.round((Date.now() - last) / 1000);
	if (Date.now() <= deadline) {
		return {
			ok: true,
			degraded: false,
			latencyMs: 0,
			detail: `last check-in ${lateSec}s ago`
		};
	}
	return {
		ok: false,
		degraded: false,
		latencyMs: 0,
		detail: `no check-in for ${lateSec}s (expected ${service.expected_interval_seconds}s)`
	};
}

function errMessage(err: unknown): string {
	if (err instanceof Error) {
		// AbortSignal.timeout produces a TimeoutError DOMException.
		if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
		const cause = err.cause instanceof Error ? `: ${err.cause.message}` : '';
		return `${err.message}${cause}`.slice(0, 200);
	}
	return String(err).slice(0, 200);
}
