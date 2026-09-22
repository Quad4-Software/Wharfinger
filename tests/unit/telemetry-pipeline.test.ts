import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Dispatcher } from 'undici';
import * as v from 'valibot';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '$lib/server/config/schema';
import type { Egress } from '$lib/server/http/egress';
import { openDb } from '$lib/server/store/db';
import { MarkerStore } from '$lib/server/store/markers';
import {
	envelopeEventId,
	eventToEnvelope,
	itemFromEnvelope,
	scrubEnvelope
} from '$lib/server/telemetry/ingest';
import {
	EventDedupe,
	flushOnce,
	ingestDup,
	ingestIpAllowed,
	ingestProjectAllowed,
	ingestStats,
	persistItem,
	relayEnqueue,
	resetIngestPipeline,
	spoolEnqueue,
	spoolSink,
	TokenBucket,
	type IngestConfig,
	type IngestDeps
} from '$lib/server/telemetry/pipeline';
import { parseUpstreamDsn, RelayForwarder, type RelayTuning } from '$lib/server/telemetry/relay';
import { EnvelopeSpool } from '$lib/server/telemetry/spool';
import { TelemetryStore } from '$lib/server/telemetry/store';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function ingestCfg(over: Partial<IngestConfig> = {}): IngestConfig {
	return {
		mode: 'local',
		upstream_dsn: '',
		upstream_timeout_ms: 10_000,
		max_queue: 100,
		flush_interval_ms: 1000,
		retry_base_ms: 1000,
		retry_max_ms: 30_000,
		retry_attempts: 5,
		rate_limit_per_minute: 600,
		...over
	};
}

const fakeEgress: Egress = {
	dispatcher: {} as Dispatcher,
	lookup: () => undefined,
	allowLinkLocal: () => true
};

function deps(over: Partial<IngestDeps> = {}): IngestDeps {
	const db = openDb(mkdtempSync(join(tmpdir(), 'wharfinger-pipe-')));
	return {
		config: {
			telemetry: {
				enabled: false,
				dsn: '',
				environment: 'test',
				client_reports: false,
				max_per_minute: 60,
				ingest: ingestCfg()
			}
		},
		egress: fakeEgress,
		telemetry: new TelemetryStore(db),
		markers: new MarkerStore(db),
		...over
	};
}

function envelope(eventId: string, msg = 'boom'): Uint8Array {
	return enc(
		[
			`{"event_id":"${eventId}"}`,
			'{"type":"event"}',
			`{"event_id":"${eventId}","message":"${msg}","level":"error"}`
		].join('\n')
	);
}

describe('[telemetry.ingest] config', () => {
	const base = {
		site: { name: 'x' },
		services: [{ id: 'a', name: 'a', type: 'http', url: 'https://a.example.com' }]
	};

	it('defaults to local so nothing changes unless configured', () => {
		const c = v.parse(Config, base);
		expect(c.telemetry.ingest.mode).toBe('local');
		expect(c.telemetry.ingest.max_queue).toBe(1000);
		expect(c.telemetry.ingest.rate_limit_per_minute).toBe(600);
	});

	it('accepts relay with an upstream dsn', () => {
		const c = v.parse(Config, {
			...base,
			telemetry: { ingest: { mode: 'relay', upstream_dsn: 'https://k@hub.example.com/4' } }
		});
		expect(c.telemetry.ingest.mode).toBe('relay');
	});

	it('rejects relay without upstream_dsn, bad modes, and non-http dsn', () => {
		expect(() => v.parse(Config, { ...base, telemetry: { ingest: { mode: 'relay' } } })).toThrow();
		expect(() => v.parse(Config, { ...base, telemetry: { ingest: { mode: 'bogus' } } })).toThrow();
		expect(() =>
			v.parse(Config, {
				...base,
				telemetry: { ingest: { mode: 'relay', upstream_dsn: 'ftp://k@h/4' } }
			})
		).toThrow();
	});
});

describe('TokenBucket', () => {
	it('allows up to the per-minute rate then rejects', () => {
		const b = new TokenBucket();
		const now = 1_000_000;
		expect(b.allow('k', 3, now)).toBe(true);
		expect(b.allow('k', 3, now)).toBe(true);
		expect(b.allow('k', 3, now)).toBe(true);
		expect(b.allow('k', 3, now)).toBe(false);
	});

	it('refills continuously', () => {
		const b = new TokenBucket();
		const now = 1_000_000;
		expect(b.allow('k', 2, now)).toBe(true);
		expect(b.allow('k', 2, now)).toBe(true);
		expect(b.allow('k', 2, now)).toBe(false);
		// 30s at 2/min refills one token.
		expect(b.allow('k', 2, now + 30_000)).toBe(true);
		expect(b.allow('k', 2, now + 30_000)).toBe(false);
	});

	it('keeps keys independent and 0 disables', () => {
		const b = new TokenBucket();
		expect(b.allow('a', 1)).toBe(true);
		expect(b.allow('b', 1)).toBe(true);
		expect(b.allow('a', 1)).toBe(false);
		expect(b.allow('a', 0)).toBe(true);
		expect(b.allow('a', 0)).toBe(true);
	});
});

describe('EventDedupe', () => {
	it('collapses repeats inside the ttl', () => {
		const d = new EventDedupe(60_000, 10);
		expect(d.isDup('1:abc', 1000)).toBe(false);
		expect(d.isDup('1:abc', 2000)).toBe(true);
		expect(d.isDup('1:def', 2000)).toBe(false);
		expect(d.isDup('1:abc', 62_000)).toBe(false);
	});

	it('evicts oldest entries past the cap', () => {
		const d = new EventDedupe(60_000, 4);
		for (let i = 0; i < 6; i++) d.isDup(`k${i}`, 1000);
		expect(d.size).toBeLessThanOrEqual(4);
	});
});

describe('EnvelopeSpool', () => {
	function spool(): EnvelopeSpool {
		const s = new EnvelopeSpool(mkdtempSync(join(tmpdir(), 'wharfinger-spool-')));
		s.init();
		return s;
	}

	it('enqueues and drains oldest first', async () => {
		const s = spool();
		expect(s.enqueue(1, 'ev1', enc('a'), 10)).toBe('ok');
		expect(s.enqueue(1, 'ev2', enc('b'), 10)).toBe('ok');
		expect(s.size).toBe(2);
		const seen: string[] = [];
		const n = await s.drain(10, (e) => {
			seen.push(dec(e.body));
			return Promise.resolve<'ok'>('ok');
		});
		expect(n).toBe(2);
		expect(seen).toEqual(['a', 'b']);
		expect(s.size).toBe(0);
	});

	it('rejects new envelopes when full', () => {
		const s = spool();
		expect(s.enqueue(1, null, enc('a'), 2)).toBe('ok');
		expect(s.enqueue(1, null, enc('b'), 2)).toBe('ok');
		expect(s.enqueue(1, null, enc('c'), 2)).toBe('full');
		expect(s.size).toBe(2);
	});

	it('keeps the file and stops on retry verdict', async () => {
		const s = spool();
		s.enqueue(1, null, enc('a'), 10);
		s.enqueue(1, null, enc('b'), 10);
		const n = await s.drain(10, () => Promise.resolve<'retry'>('retry'));
		expect(n).toBe(0);
		expect(s.size).toBe(2);
	});

	it('deletes poison files the sink drops', async () => {
		const s = spool();
		s.enqueue(1, null, enc('bad'), 10);
		const n = await s.drain(10, () => Promise.resolve<'drop'>('drop'));
		expect(n).toBe(1);
		expect(s.size).toBe(0);
	});

	it('init sweeps partial tmp writes and foreign files', () => {
		const dir = mkdtempSync(join(tmpdir(), 'wharfinger-spool-'));
		writeFileSync(join(dir, '.partial.envelope.tmp'), 'half');
		writeFileSync(join(dir, 'stray.txt'), 'x');
		writeFileSync(join(dir, '1700000000000-00000001-p1-abcd-ok.envelope'), 'fine');
		const s = new EnvelopeSpool(dir);
		s.init();
		expect(readdirSync(dir)).toEqual(['1700000000000-00000001-p1-abcd-ok.envelope']);
	});
});

describe('relay', () => {
	it('parses dsn variants and rejects bad ones', () => {
		const up = parseUpstreamDsn('https://abc123@bugs.example.com/4');
		expect(up?.endpoint).toBe('https://bugs.example.com/api/4/envelope/');
		expect(up?.publicKey).toBe('abc123');
		expect(parseUpstreamDsn('https://k@host.io/prefix/9')?.endpoint).toBe(
			'https://host.io/prefix/api/9/envelope/'
		);
		expect(parseUpstreamDsn('https://host.io/4')).toBeNull();
		expect(parseUpstreamDsn('ftp://k@h/4')).toBeNull();
		expect(parseUpstreamDsn('')).toBeNull();
	});

	const up = { endpoint: 'https://up.example.com/api/4/envelope/', publicKey: 'k' };

	function forwarder(statuses: number[], tuning: Partial<RelayTuning> = {}) {
		const sent: string[] = [];
		let i = 0;
		const fetchFn = ((url: unknown) => {
			sent.push(String(url));
			return Promise.resolve(new Response('x', { status: statuses[i++] ?? 200 }));
		}) as typeof fetch;
		const f = new RelayForwarder(
			fakeEgress,
			() => ({
				timeoutMs: 5000,
				retryBaseMs: 100,
				retryMaxMs: 1000,
				retryAttempts: 3,
				maxPending: 4,
				...tuning
			}),
			fetchFn,
			() => Promise.resolve()
		);
		return { f, sent };
	}

	it('forwards envelopes upstream', async () => {
		const { f, sent } = forwarder([200]);
		expect(f.enqueue(up, enc('env'))).toBe(true);
		await f.idle();
		expect(sent).toEqual([up.endpoint]);
		expect(f.stats().forwarded).toBe(1);
	});

	it('retries 5xx with backoff then succeeds', async () => {
		const { f, sent } = forwarder([500, 500, 200]);
		f.enqueue(up, enc('env'));
		await f.idle();
		expect(sent).toHaveLength(3);
		expect(f.stats().forwarded).toBe(1);
		expect(f.stats().upstreamFailures).toBe(2);
		expect(f.stats().retries).toBe(2);
	});

	it('drops on 4xx without retrying', async () => {
		const { f, sent } = forwarder([400]);
		f.enqueue(up, enc('env'));
		await f.idle();
		expect(sent).toHaveLength(1);
		expect(f.stats().dropped).toBe(1);
	});

	it('drops after exhausting retries', async () => {
		const { f, sent } = forwarder([503, 503, 503, 503, 503], { retryAttempts: 2 });
		f.enqueue(up, enc('env'));
		await f.idle();
		expect(sent).toHaveLength(3);
		expect(f.stats().dropped).toBe(1);
	});

	it('bounds the pending buffer', () => {
		const { f } = forwarder([], { maxPending: 2 });
		expect(f.enqueue(up, enc('a'))).toBe(true);
		expect(f.enqueue(up, enc('b'))).toBe(true);
		expect(f.enqueue(up, enc('c'))).toBe(false);
	});
});

describe('scrubEnvelope / eventToEnvelope', () => {
	it('preserves the header event_id and filters secrets', () => {
		const body = enc(
			[
				'{"event_id":"cafe1234","dsn":"https://k@h/1"}',
				'{"type":"event"}',
				'{"event_id":"cafe1234","password":"hunter2","message":"hi"}'
			].join('\n')
		);
		const clean = scrubEnvelope(body);
		expect(clean).not.toBeNull();
		const text = dec(clean!);
		expect(text).toContain('cafe1234');
		expect(text).not.toContain('hunter2');
		expect(text).toContain('[Filtered]');
		expect(envelopeEventId(clean!)).toBe('cafe1234');
		expect(itemFromEnvelope(clean!)?.kind).toBe('event');
	});

	it('passes non-JSON item payloads through verbatim', () => {
		const body = enc(
			['{"event_id":"a"}', '{"type":"attachment","length":5}', '\x00\x01\x02\x03\x04'].join('\n')
		);
		const clean = scrubEnvelope(body);
		expect(clean).not.toBeNull();
		expect(dec(clean!)).toContain('attachment');
	});

	it('rejects bodies without a parseable header', () => {
		expect(scrubEnvelope(enc('not json at all'))).toBeNull();
		expect(envelopeEventId(enc('{"event_id":"abc"}'))).toBe('abc');
		expect(envelopeEventId(enc(''))).toBeNull();
	});

	it('wraps a store event into a parseable envelope', () => {
		const env = eventToEnvelope({ event_id: 'feed42', message: 'x', password: 'p' });
		expect(envelopeEventId(env)).toBe('feed42');
		expect(itemFromEnvelope(env)?.kind).toBe('event');
		const clean = scrubEnvelope(env)!;
		expect(dec(clean)).not.toContain('"password":"p"');
	});
});

describe('pipeline dispatch', () => {
	beforeEach(() => {
		resetIngestPipeline();
	});

	it('rate limits per ip and per project', () => {
		const cfg = ingestCfg({ rate_limit_per_minute: 2 });
		expect(ingestIpAllowed(cfg, '1.2.3.4')).toBe(true);
		expect(ingestIpAllowed(cfg, '1.2.3.4')).toBe(true);
		expect(ingestIpAllowed(cfg, '1.2.3.4')).toBe(false);
		expect(ingestIpAllowed(cfg, '5.6.7.8')).toBe(true);
		expect(ingestProjectAllowed(cfg, 1)).toBe(true);
		expect(ingestProjectAllowed(cfg, 1)).toBe(true);
		expect(ingestProjectAllowed(cfg, 1)).toBe(false);
		expect(ingestProjectAllowed(cfg, 2)).toBe(true);
	});

	it('dedupes repeated event ids', () => {
		expect(ingestDup(1, 'ev1')).toBe(false);
		expect(ingestDup(1, 'ev1')).toBe(true);
		expect(ingestDup(2, 'ev1')).toBe(false);
	});

	it('reports misconfigured relay mode without an upstream dsn', () => {
		const rt = deps();
		expect(relayEnqueue(rt, ingestCfg({ mode: 'relay' }), enc('env'))).toBe('misconfigured');
	});

	it('persistItem stores events and collapses duplicates', async () => {
		const store = new TelemetryStore(openDb(mkdtempSync(join(tmpdir(), 'wharfinger-evt-'))));
		const rt = deps({ telemetry: store });
		const proj = await store.createProject('app');
		const item = itemFromEnvelope(envelope('ev100'))!;
		const first = await persistItem(rt, proj.id, item);
		expect(first.status).toBe('ok');
		const second = await persistItem(rt, proj.id, itemFromEnvelope(envelope('ev100'))!);
		expect(second.status).toBe('dup');
		const issues = await store.issues(proj.id, { limit: 10 });
		expect(issues.total).toBe(1);
		expect(issues.entries[0].count).toBe(1);
	});

	it('spoolSink flushes spooled envelopes into the store', async () => {
		const store = new TelemetryStore(openDb(mkdtempSync(join(tmpdir(), 'wharfinger-evt-'))));
		const rt = deps({ telemetry: store });
		const proj = await store.createProject('app');
		const s = new EnvelopeSpool(mkdtempSync(join(tmpdir(), 'wharfinger-flush-')));
		s.init();
		s.enqueue(proj.id, 'ev200', envelope('ev200'), 10);
		expect(await s.drain(10, (e) => spoolSink(rt, e))).toBe(1);
		expect((await store.issues(proj.id, { limit: 10 })).total).toBe(1);
		expect(s.size).toBe(0);
	});

	it('spoolSink drops envelopes for disabled projects', async () => {
		const store = new TelemetryStore(openDb(mkdtempSync(join(tmpdir(), 'wharfinger-evt-'))));
		const rt = deps({ telemetry: store });
		const proj = await store.createProject('app');
		await store.setProjectDisabled(proj.id, true);
		expect(await spoolSink(rt, { projectId: proj.id, body: envelope('ev300') })).toBe('drop');
		expect((await store.issues(null, { limit: 10 })).total).toBe(0);
	});

	it('queue mode end to end: spool to disk then flush to the store', async () => {
		vi.stubEnv('WHARFINGER_DATA_DIR', mkdtempSync(join(tmpdir(), 'wharfinger-data-')));
		const store = new TelemetryStore(openDb(mkdtempSync(join(tmpdir(), 'wharfinger-evt-'))));
		const rt = deps({ telemetry: store });
		const proj = await store.createProject('app');
		const cfg = ingestCfg({ mode: 'queue' });
		expect(spoolEnqueue(cfg, proj.id, 'ev500', envelope('ev500'))).toBe('ok');
		expect(ingestStats().queued).toBe(1);
		expect(ingestStats().spoolDepth).toBe(1);
		expect(await flushOnce(rt)).toBe(1);
		expect((await store.issues(proj.id, { limit: 10 })).total).toBe(1);
		expect(ingestStats().spoolDepth).toBe(0);
		vi.unstubAllEnvs();
	});

	it('spoolSink retries when the store throws', async () => {
		const rt = deps({
			telemetry: {
				project: () =>
					Promise.resolve({
						id: 1,
						name: 'x',
						publicKey: 'k',
						platform: null,
						createdAt: 0,
						disabledAt: null
					}),
				record: () => Promise.reject(new Error('db down')),
				recordTrace: () => Promise.resolve()
			}
		});
		const verdict = await spoolSink(rt, { projectId: 1, body: envelope('ev400') });
		expect(verdict).toBe('retry');
	});
});
