import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { verify } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '$lib/server/store/db';
import { AgentStore, hashToken } from '$lib/server/ingress/agents';
import { publicKeyB64, signToken } from '$lib/server/ingress/keys';
import { AgentPayload } from '$lib/server/ingress/schema';

function freshDb(): DatabaseSync {
	return openDb(mkdtempSync(join(tmpdir(), 'wharfinger-ingress-')));
}

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		v: 1,
		fingerprint: 'fp_abc123',
		ts: Date.now(),
		agent: { version: '0.1.0', hostname: 'h1', os: 'linux', arch: 'amd64', uptimeSec: 60 },
		cpu: { pct: 12.5, cores: 8, load1: 0.5, load5: 0.4, load15: 0.3 },
		mem: { total: 1e9, used: 5e8, available: 5e8, pct: 50, swapTotal: 0, swapUsed: 0 },
		net: { rxBps: 100, txBps: 200 },
		connections: { established: 1, listen: 2, timeWait: 0, udp: 3, total: 6 },
		security: {},
		...over
	};
}

describe('AgentStore', () => {
	it('issues tokens and resolves them by hash', () => {
		const db = freshDb();
		const store = new AgentStore(db);
		const { id, token } = store.create('web-1', '1');
		expect(token).toMatch(/^st_/);
		const agent = store.resolveToken(token);
		expect(agent?.id).toBe(id);
		expect(store.resolveToken('st_wrong')).toBeNull();
		// Raw token is never stored.
		const row = db.prepare('SELECT token_hash FROM agents WHERE id = ?').get(id) as {
			token_hash: string;
		};
		expect(row.token_hash).toBe(hashToken(token));
		expect(row.token_hash).not.toBe(token);
	});

	it('rejects revoked tokens', () => {
		const store = new AgentStore(freshDb());
		const { id, token } = store.create('a', null);
		store.revoke(id);
		expect(store.resolveToken(token)).toBeNull();
	});

	it('binds the first fingerprint and rejects later mismatches', () => {
		const store = new AgentStore(freshDb());
		const { id } = store.create('a', null);
		const agent = store.get(id)!;
		expect(store.checkFingerprint(agent, 'fp_one')).toBe('bound');
		expect(store.checkFingerprint(store.get(id)!, 'fp_one')).toBe('ok');
		expect(store.checkFingerprint(store.get(id)!, 'fp_two')).toBe('mismatch');
	});

	it('never binds an empty fingerprint', () => {
		const store = new AgentStore(freshDb());
		const { id } = store.create('a', null);
		expect(store.checkFingerprint(store.get(id)!, '')).toBe('ok');
		expect(store.get(id)!.fingerprint).toBeNull();
	});

	it('records samples and prunes old rows', () => {
		const store = new AgentStore(freshDb());
		const { id } = store.create('a', null);
		const p = v.parse(AgentPayload, payload({ ts: Date.now() - 10 * 86_400_000 }));
		store.record(id, p);
		store.record(id, v.parse(AgentPayload, payload()));
		expect(store.history(id, 0)).toHaveLength(2);
		store.prune(Date.now() - 5 * 86_400_000);
		const rest = store.history(id, 0);
		expect(rest).toHaveLength(1);
		const latest = store.get(id)!;
		expect(latest.lastSeenAt).not.toBeNull();
		expect(latest.meta).toMatchObject({ hostname: 'h1', arch: 'amd64' });
	});

	it('deletes samples with the agent', () => {
		const store = new AgentStore(freshDb());
		const { id } = store.create('a', null);
		store.record(id, v.parse(AgentPayload, payload()));
		store.remove(id);
		expect(store.get(id)).toBeNull();
		expect(store.history(id, 0)).toHaveLength(0);
	});

	it('dedupes replayed samples on (agent_id, ts)', () => {
		const store = new AgentStore(freshDb());
		const { id } = store.create('a', null);
		const ts = Date.now() - 60_000;
		const p = v.parse(AgentPayload, payload({ ts, backfill: true }));
		store.record(id, p);
		store.record(id, p); // replay after a reconnect
		expect(store.history(id, 0)).toHaveLength(1);
	});

	it('backfill fills the series without regressing last_payload', () => {
		const store = new AgentStore(freshDb());
		const { id } = store.create('a', null);
		store.record(id, v.parse(AgentPayload, payload()));
		const livePayload = (store.get(id)!.lastPayload as { ts: number }).ts;

		store.record(id, v.parse(AgentPayload, payload({ ts: Date.now() - 3600_000, backfill: true })));
		const row = store.get(id)!;
		expect((row.lastPayload as { ts: number }).ts).toBe(livePayload);
		expect(store.history(id, 0)).toHaveLength(2);
	});

	it('buckets history to a bounded point count', () => {
		const store = new AgentStore(freshDb());
		const { id } = store.create('a', null);
		// 100 samples 1min apart over a 100min window.
		const base = Date.now() - 100 * 60_000;
		for (let i = 0; i < 100; i++) {
			store.record(id, v.parse(AgentPayload, payload({ ts: base + i * 60_000 })));
		}
		const wide = store.history(id, base, 10);
		expect(wide.length).toBeLessThanOrEqual(11);
		expect(wide.length).toBeGreaterThan(7);
		const raw = store.history(id, base, 10000);
		expect(raw).toHaveLength(100);
	});
});

describe('AgentPayload schema', () => {
	it('accepts a minimal payload', () => {
		const r = v.safeParse(AgentPayload, payload());
		expect(r.success).toBe(true);
	});

	it('accepts a fully populated payload', () => {
		const r = v.safeParse(
			AgentPayload,
			payload({
				disks: [{ mount: '/', fstype: 'ext4', total: 1e9, used: 5e8, pct: 50 }],
				temps: [{ label: 'cpu', celsius: 55 }],
				gpus: [{ vendor: 'nvidia', name: 'RTX', tempC: 60 }],
				ports: [{ proto: 'tcp', port: 443, address: '0.0.0.0' }],
				docker: {
					running: 1,
					total: 2,
					containers: [{ id: 'x', name: 'c', image: 'i', state: 'running', status: 'Up' }]
				},
				services: [{ name: 'sshd', manager: 'systemd', state: 'active' }],
				security: {
					ufw: { enabled: true, rules: 5 },
					fail2ban: { enabled: true, jails: [{ name: 'sshd', banned: 2 }] }
				}
			})
		);
		expect(r.success).toBe(true);
	});

	it('rejects wrong version, bad types, and oversized arrays', () => {
		// v is a floor: newer agents (v: 2+) are accepted and unknown
		// fields are stripped; v < 1 is rejected.
		expect(v.safeParse(AgentPayload, payload({ v: 0 })).success).toBe(false);
		expect(v.safeParse(AgentPayload, payload({ v: 2 })).success).toBe(true);
		expect(v.safeParse(AgentPayload, payload({ ts: 'now' })).success).toBe(false);
		expect(
			v.safeParse(AgentPayload, {
				...payload(),
				ports: Array.from({ length: 3000 }, (_, i) => ({
					proto: 'tcp',
					port: i % 65536,
					address: 'x'
				}))
			}).success
		).toBe(false);
		expect(
			v.safeParse(AgentPayload, {
				...payload(),
				cpu: { pct: -1, cores: 1, load1: 0, load5: 0, load15: 0 }
			}).success
		).toBe(false);
	});

	it('caps oversized collections and strings', () => {
		const big = payload({
			services: Array.from({ length: 3000 }, () => ({
				name: 'x',
				manager: 'systemd',
				state: 'active'
			}))
		});
		expect(v.safeParse(AgentPayload, big).success).toBe(false);
	});
});

describe('hub keys', () => {
	it('signs tokens verifiably and persists the keypair', () => {
		const db = freshDb();
		const sig = signToken(db, 'st_testtoken');
		const pub = Buffer.from(publicKeyB64(db), 'base64');
		expect(pub).toHaveLength(32);
		const ok = verify(
			null,
			Buffer.from('st_testtoken'),
			{
				key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]),
				format: 'der',
				type: 'spki'
			},
			Buffer.from(sig, 'base64')
		);
		expect(ok).toBe(true);
		// Stable across calls (same db row).
		expect(signToken(db, 'x')).toBe(signToken(db, 'x'));
	});
});
