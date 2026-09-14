import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';

// Ingress e2e: exercises the production server.js path, so the ws
// bridge and the REST endpoints both run. Agents are seeded straight
// into the e2e database (same store the admin API writes through).

const DB = 'test-results/e2e-data/wharfinger.db';
const TOKEN = 'st_e2e-test-token';

function open(): DatabaseSync {
	const db = new DatabaseSync(DB);
	db.exec('PRAGMA busy_timeout = 10000;');
	return db;
}

function seedAgent(id = 'ag_e2e', token = TOKEN): void {
	const db = open();
	// INSERT OR REPLACE is atomic: a parallel test's token lookup never
	// observes a missing row between a delete and an insert.
	db.prepare(
		'INSERT OR REPLACE INTO agents (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)'
	).run(id, 'e2e host', createHash('sha256').update(token).digest('hex'), Date.now());
	db.close();
}

function payload(fp = 'fp_e2e'): Record<string, unknown> {
	return {
		v: 1,
		fingerprint: fp,
		ts: Date.now(),
		agent: { version: '0.1.0', hostname: 'e2e', os: 'linux', arch: 'amd64', uptimeSec: 5 },
		cpu: { pct: 10, cores: 4, load1: 0.1, load5: 0.2, load15: 0.3 },
		mem: { total: 1000, used: 500, available: 500, pct: 50, swapTotal: 0, swapUsed: 0 },
		net: { rxBps: 1, txBps: 2 },
		connections: { established: 1, listen: 1, timeWait: 0, udp: 0, total: 2 },
		security: {}
	};
}

test('ingress pubkey is exposed', async ({ request }) => {
	const res = await request.get('/ingress/pubkey');
	expect(res.ok()).toBe(true);
	const body = (await res.json()) as { pub: string };
	expect(Buffer.from(body.pub, 'base64')).toHaveLength(32);
});

test('ingress rejects missing and bad tokens', async ({ request }) => {
	expect((await request.post('/ingress', { data: payload() })).status()).toBe(401);
	expect(
		(
			await request.post('/ingress', {
				headers: { authorization: 'Bearer st_wrong' },
				data: payload()
			})
		).status()
	).toBe(401);
});

test('ingress accepts a payload, binds the fingerprint, rejects mismatches', async ({
	request
}) => {
	seedAgent();
	const auth = { authorization: `Bearer ${TOKEN}` };
	const ok = await request.post('/ingress', { headers: auth, data: payload() });
	expect(ok.status()).toBe(200);
	// Same fingerprint stays ok.
	expect((await request.post('/ingress', { headers: auth, data: payload() })).status()).toBe(200);
	// A different machine with the same token is rejected.
	expect(
		(await request.post('/ingress', { headers: auth, data: payload('fp_other') })).status()
	).toBe(403);
	// Malformed payloads are rejected by the schema.
	expect((await request.post('/ingress', { headers: auth, data: { v: 0 } })).status()).toBe(422);
});

test('ws bridge completes the handshake and ingests metrics', async () => {
	// Dedicated agent id: parallel tests re-seed ag_e2e and would reset
	// the fingerprint this test binds via the ws hello.
	seedAgent('ag_e2e_ws', 'st_e2e-ws-token');
	const ws = new WebSocket('ws://127.0.0.1:4173/ingress/ws', {
		headers: { authorization: 'Bearer st_e2e-ws-token' }
	});
	try {
		const frames: Record<string, unknown>[] = [];
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error('ws timeout'));
			}, 15_000);
			ws.on('message', (raw: Buffer) => {
				const msg = JSON.parse(raw.toString()) as { type: string; signature?: string };
				frames.push(msg);
				if (msg.type === 'challenge') {
					expect(typeof msg.signature).toBe('string');
					ws.send(JSON.stringify({ type: 'hello', fingerprint: 'fp_e2e_ws', v: 1 }));
				}
				if (msg.type === 'ready') {
					ws.send(JSON.stringify({ type: 'metrics', data: payload('fp_e2e_ws') }));
					clearTimeout(timer);
					resolve();
				}
				if (msg.type === 'error') {
					clearTimeout(timer);
					reject(new Error(`ws error frame: ${JSON.stringify(msg)}`));
				}
			});
			ws.on('error', reject);
		});
		expect(frames.map((f) => f.type)).toEqual(['challenge', 'ready']);
		// Give the loopback POST a moment, then confirm the row landed.
		await new Promise((r) => setTimeout(r, 500));
		const db = open();
		const row = db
			.prepare('SELECT last_seen_at, last_payload, fingerprint FROM agents WHERE id = ?')
			.get('ag_e2e_ws') as {
			last_seen_at: number | null;
			last_payload: string | null;
			fingerprint: string | null;
		};
		db.close();
		expect(row.fingerprint).toBe('fp_e2e_ws');
		expect(row.last_payload).toContain('"hostname":"e2e"');
	} finally {
		ws.close();
	}
});

test('backfill payloads are accepted within the window and deduped', async ({ request }) => {
	// Separate agent id: tests run in parallel and share the db.
	seedAgent('ag_e2e_backfill', 'st_e2e-backfill-token');
	const auth = { authorization: 'Bearer st_e2e-backfill-token' };

	const backfillTs = Date.now() - 3600_000;
	const old = { ...payload(), ts: backfillTs, backfill: true };
	const first = await request.post('/ingress', { headers: auth, data: old });
	expect(first.status()).toBe(200);
	// A replayed duplicate of the same sample is accepted but deduped.
	const dup = await request.post('/ingress', { headers: auth, data: old });
	expect(dup.status()).toBe(200);
	// Backfill older than 48h is rejected.
	const ancient = { ...old, ts: Date.now() - 72 * 3600_000 };
	expect((await request.post('/ingress', { headers: auth, data: ancient })).status()).toBe(422);
	// A non-backfill payload with an old ts is still rejected.
	const stale = { ...payload(), ts: Date.now() - 3600_000 };
	expect((await request.post('/ingress', { headers: auth, data: stale })).status()).toBe(422);

	const db2 = open();
	const row = db2
		.prepare('SELECT count(*) AS n FROM agent_samples WHERE agent_id = ? AND ts = ?')
		.get('ag_e2e_backfill', backfillTs) as { n: number };
	db2.close();
	expect(row.n).toBe(1);
});

test('edge reports are ingested, deduped, and gated', async ({ request }) => {
	seedAgent('ag_e2e_edge', 'st_e2e-edge-token');
	const auth = { authorization: 'Bearer st_e2e-edge-token' };
	const report = (ts: number): Record<string, unknown> => ({
		v: 1,
		ts,
		windowSec: 60,
		requests: 120,
		s2xx: 100,
		s3xx: 10,
		s4xx: 8,
		s5xx: 2,
		latencyP50: 10,
		clients: [{ ip: '203.0.113.7', requests: 60 }],
		paths: [{ path: '/api', requests: 80, errors: 2 }],
		errors: [
			{ ts, method: 'GET', host: 'example.com', path: '/api', status: 500, ip: '203.0.113.7' }
		]
	});

	// No token and bad schema are refused before any db work.
	expect((await request.post('/ingress/edge', { data: report(Date.now()) })).status()).toBe(401);
	expect((await request.post('/ingress/edge', { headers: auth, data: { v: 0 } })).status()).toBe(
		422
	);

	const ts = Date.now() - 60_000;
	expect((await request.post('/ingress/edge', { headers: auth, data: report(ts) })).status()).toBe(
		200
	);
	// A plugin retry of the same window is deduped.
	expect((await request.post('/ingress/edge', { headers: auth, data: report(ts) })).status()).toBe(
		200
	);
	// Clock skew beyond an hour is rejected.
	expect(
		(
			await request.post('/ingress/edge', {
				headers: auth,
				data: report(Date.now() + 2 * 3600_000)
			})
		).status()
	).toBe(422);

	const db = open();
	const row = db
		.prepare('SELECT count(*) AS n FROM edge_reports WHERE agent_id = ? AND ts = ?')
		.get('ag_e2e_edge', ts) as { n: number };
	// Reporting also proves the agent is alive.
	const alive = db.prepare('SELECT last_seen_at FROM agents WHERE id = ?').get('ag_e2e_edge') as {
		last_seen_at: number | null;
	};
	db.close();
	expect(row.n).toBe(1);
	expect(alive.last_seen_at).not.toBeNull();
});

test('ws upgrade without a token is refused', async () => {
	await expect(
		new Promise((resolve, reject) => {
			const ws = new WebSocket('ws://127.0.0.1:4173/ingress/ws');
			ws.on('open', () => {
				resolve(ws);
			});
			ws.on('error', (e: Error) => {
				reject(e);
			});
			ws.on('unexpected-response', (_req: unknown, res: { statusCode: number }) => {
				reject(new Error(`status ${res.statusCode}`));
			});
		})
	).rejects.toThrow();
});
