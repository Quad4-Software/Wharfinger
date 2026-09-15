import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { asDb, type Db } from '$lib/server/store/driver';
import type { AgentPayload } from './schema';
import type { AgentMeta } from '$lib/shared/agents';

export interface AgentRow {
	id: string;
	name: string;
	fingerprint: string | null;
	/** base64 raw 32-byte ed25519 identity key; null = legacy agent. */
	pubkey: string | null;
	/** Internal: pending hello nonce, never exposed via views. */
	bindNonce: string | null;
	createdAt: number;
	createdBy: string | null;
	lastSeenAt: number | null;
	meta: AgentMeta | null;
	alerts: Record<string, number>;
	revokedAt: number | null;
}

interface AgentDbRow {
	id: string;
	name: string;
	token_hash: string;
	fingerprint: string | null;
	pubkey: string | null;
	bind_nonce: string | null;
	created_at: number;
	created_by: string | null;
	last_seen_at: number | null;
	last_payload: string | null;
	meta: string | null;
	alerts: string | null;
	revoked_at: number | null;
}

export function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

/** New registration token, shown to the operator exactly once. */
export function newToken(): string {
	return 'st_' + randomBytes(24).toString('base64url');
}

// Stored JSON (meta, alerts, last_payload) is self-written but a
// corrupt row must not 500 the admin API.
function safeJson<T>(raw: string | null, fallback: T): T {
	if (!raw) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

function toRow(r: AgentDbRow): AgentRow {
	return {
		id: r.id,
		name: r.name,
		fingerprint: r.fingerprint,
		pubkey: r.pubkey,
		bindNonce: r.bind_nonce,
		createdAt: r.created_at,
		createdBy: r.created_by,
		lastSeenAt: r.last_seen_at,
		meta: safeJson<AgentMeta | null>(r.meta, null),
		alerts: safeJson<Record<string, number>>(r.alerts, {}),
		revokedAt: r.revoked_at
	};
}

/**
 * Agent registry + metrics persistence. Token lookup goes through a
 * sha256 index so the raw bearer value never touches the db, mirroring
 * how session cookies are stored.
 */
export class AgentStore {
	private readonly db: Db;

	constructor(db: Db | DatabaseSync) {
		this.db = asDb(db);
	}

	async create(name: string, createdBy: string | null): Promise<{ id: string; token: string }> {
		const id = 'ag_' + randomBytes(9).toString('base64url');
		const token = newToken();
		await this.db
			.prepare(
				'INSERT INTO agents (id, name, token_hash, created_at, created_by) VALUES (?, ?, ?, ?, ?)'
			)
			.run(id, name, hashToken(token), Date.now(), createdBy);
		return { id, token };
	}

	/** Resolve a bearer token to an active agent row, or null. */
	async resolveToken(token: string): Promise<(AgentRow & { tokenHash: string }) | null> {
		if (typeof token !== 'string' || token.length < 8 || token.length > 256) return null;
		const r = (await this.db
			.prepare('SELECT * FROM agents WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1')
			.get(hashToken(token))) as AgentDbRow | undefined;
		if (!r) return null;
		return { ...toRow(r), tokenHash: r.token_hash };
	}

	/**
	 * Fingerprint binding, Beszel-style: the first fingerprint an agent
	 * presents is locked in; later mismatches are rejected. An empty
	 * fingerprint (host without stable ids) is never bound and never
	 * rejected.
	 */
	async checkFingerprint(agent: AgentRow, fp: string): Promise<'ok' | 'bound' | 'mismatch'> {
		if (!fp) return 'ok';
		if (agent.fingerprint === null) {
			// Conditional write: two concurrent first payloads cannot
			// both bind. Whoever loses the race re-reads and must match.
			const r = await this.db
				.prepare('UPDATE agents SET fingerprint = ? WHERE id = ? AND fingerprint IS NULL')
				.run(fp, agent.id);
			if (Number(r.changes) > 0) return 'bound';
			const cur = (await this.db
				.prepare('SELECT fingerprint FROM agents WHERE id = ?')
				.get(agent.id)) as { fingerprint: string | null } | undefined;
			return cur?.fingerprint === fp ? 'ok' : 'mismatch';
		}
		return agent.fingerprint === fp ? 'ok' : 'mismatch';
	}

	/**
	 * Pubkey binding, same TOFU model as the fingerprint: the first
	 * identity key an agent proves is locked in; later mismatches are
	 * rejected. The caller must verify the proof BEFORE calling this:
	 * binding only ever happens for a key that just produced a valid
	 * signature.
	 */
	async checkPubkey(agent: AgentRow, pubkey: string): Promise<'ok' | 'bound' | 'mismatch'> {
		if (agent.pubkey === null) {
			const r = await this.db
				.prepare('UPDATE agents SET pubkey = ? WHERE id = ? AND pubkey IS NULL')
				.run(pubkey, agent.id);
			if (Number(r.changes) > 0) return 'bound';
			const cur = (await this.db
				.prepare('SELECT pubkey FROM agents WHERE id = ?')
				.get(agent.id)) as { pubkey: string | null } | undefined;
			return cur?.pubkey === pubkey ? 'ok' : 'mismatch';
		}
		return agent.pubkey === pubkey ? 'ok' : 'mismatch';
	}

	// The hello nonce is issued by /ingress/handshake and consumed by
	// /ingress/hello, so the proof an agent signs is always a fresh
	// hub-chosen value and cannot be replayed across connections.
	async setBindNonce(id: string, nonce: string): Promise<void> {
		await this.db.prepare('UPDATE agents SET bind_nonce = ? WHERE id = ?').run(nonce, id);
	}

	async clearBindNonce(id: string): Promise<void> {
		await this.db.prepare('UPDATE agents SET bind_nonce = NULL WHERE id = ?').run(id);
	}

	/** Persist a validated payload: latest blob, meta, and a sample row. */
	async record(agentId: string, p: AgentPayload): Promise<void> {
		await this.db.tx(async (tx) => {
			await this.recordInner(tx, agentId, p);
		});
	}

	private async recordInner(tx: Db, agentId: string, p: AgentPayload): Promise<void> {
		const meta = JSON.stringify({
			version: p.agent.version,
			hostname: p.agent.hostname,
			os: p.agent.os,
			arch: p.agent.arch,
			kernel: p.agent.kernel ?? null,
			uptimeSec: p.agent.uptimeSec,
			caps: p.agent.caps ?? null
		});
		const diskPct = p.disks && p.disks.length > 0 ? Math.max(...p.disks.map((d) => d.pct)) : null;
		const diskUsed = p.disks && p.disks.length > 0 ? p.disks.reduce((a, d) => a + d.used, 0) : null;
		const tempMax =
			p.temps && p.temps.length > 0 ? Math.max(...p.temps.map((t) => t.celsius)) : null;
		// OR IGNORE: a replayed backfill sample with a duplicate
		// (agent_id, ts) is dropped instead of failing the payload.
		const ins = tx.prepare(
			'INSERT OR IGNORE INTO agent_samples (agent_id, ts, cpu, mem_pct, disk_pct, rx_bps, tx_bps, load1, temp_max, mem_used, disk_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
		);
		await ins.run(
			agentId,
			p.ts,
			p.cpu.pct,
			p.mem.pct,
			diskPct,
			p.net.rxBps,
			p.net.txBps,
			p.cpu.load1,
			tempMax,
			p.mem.used,
			diskUsed
		);
		if (p.backfill) {
			// Late data fills the series but must not regress the
			// latest-payload blob or meta to an older sample.
			await tx.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(Date.now(), agentId);
		} else {
			await tx
				.prepare('UPDATE agents SET last_seen_at = ?, last_payload = ?, meta = ? WHERE id = ?')
				.run(Date.now(), JSON.stringify(p), meta, agentId);
		}
	}

	// Touch marks the registration alive without replacing the payload
	// blob; used by auxiliary feeds like edge reports that carry no
	// system metrics of their own.
	async touch(agentId: string): Promise<void> {
		await this.db
			.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?')
			.run(Date.now(), agentId);
	}

	async list(): Promise<(AgentRow & { lastPayload: unknown })[]> {
		const rows = (await this.db
			.prepare('SELECT * FROM agents ORDER BY created_at ASC')
			.all()) as unknown as AgentDbRow[];
		return rows.map((r) => ({
			...toRow(r),
			lastPayload: safeJson<unknown>(r.last_payload, null)
		}));
	}

	async get(id: string): Promise<(AgentRow & { lastPayload: unknown }) | null> {
		const r = (await this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id)) as
			AgentDbRow | undefined;
		if (!r) return null;
		return {
			...toRow(r),
			lastPayload: safeJson<unknown>(r.last_payload, null)
		};
	}

	async revoke(id: string): Promise<void> {
		// Clearing alerts silences a revoked agent without a bogus
		// recovery notification; the alerter never scans revoked rows.
		await this.db
			.prepare('UPDATE agents SET revoked_at = ?, alerts = NULL WHERE id = ?')
			.run(Date.now(), id);
	}

	/** Persist the active-alert map after the alerter mutates it. */
	async setAlerts(id: string, alerts: Record<string, number>): Promise<void> {
		await this.db
			.prepare('UPDATE agents SET alerts = ? WHERE id = ?')
			.run(Object.keys(alerts).length > 0 ? JSON.stringify(alerts) : null, id);
	}

	/**
	 * Lightweight rows for the periodic offline scan: no last_payload
	 * parsing, just what the alerter needs.
	 */
	async scan(): Promise<
		{
			id: string;
			name: string;
			lastSeenAt: number | null;
			alerts: Record<string, number>;
		}[]
	> {
		const rows = (await this.db
			.prepare('SELECT id, name, last_seen_at, alerts FROM agents WHERE revoked_at IS NULL')
			.all()) as unknown as Pick<AgentDbRow, 'id' | 'name' | 'last_seen_at' | 'alerts'>[];
		return rows.map((r) => ({
			id: r.id,
			name: r.name,
			lastSeenAt: r.last_seen_at,
			alerts: safeJson<Record<string, number>>(r.alerts, {})
		}));
	}

	async remove(id: string): Promise<void> {
		// Samples are children of the agent row; surreal has no FK
		// cascade, so both deletes live in one transaction.
		await this.db.tx(async (tx) => {
			await tx.prepare('DELETE FROM agent_samples WHERE agent_id = ?').run(id);
			await tx.prepare('DELETE FROM agents WHERE id = ?').run(id);
		});
	}

	/**
	 * Series rows for graphs, bucketed to at most maxPoints so long
	 * ranges stay cheap to query, transfer, and render. Buckets are
	 * fixed-width averages aligned to epoch ms.
	 */
	async history(
		agentId: string,
		sinceMs: number,
		maxPoints = 600
	): Promise<Record<string, unknown>[]> {
		// Bucket off the real data span, not the query span: a 30d
		// range on an agent with 1h of data must not collapse into one
		// bucket, and vice versa the cap still holds at maxPoints.
		const first = (await this.db
			.prepare('SELECT MIN(ts) AS m FROM agent_samples WHERE agent_id = ? AND ts >= ?')
			.get(agentId, sinceMs)) as { m: number | null } | undefined;
		const span = Math.max(Date.now() - Math.max(sinceMs, first?.m ?? Date.now()), 1);
		const bucket = Math.max(1, Math.ceil(span / maxPoints));
		return this.db
			.prepare(
				`SELECT CAST(ts / ? AS INTEGER) * ? AS ts,
					avg(cpu) AS cpu, avg(mem_pct) AS mem_pct, avg(disk_pct) AS disk_pct,
					avg(rx_bps) AS rx_bps, avg(tx_bps) AS tx_bps, avg(load1) AS load1,
					avg(temp_max) AS temp_max, avg(mem_used) AS mem_used, avg(disk_used) AS disk_used
				FROM agent_samples WHERE agent_id = ? AND ts >= ?
				GROUP BY CAST(ts / ? AS INTEGER) ORDER BY ts ASC`
			)
			.all(bucket, bucket, agentId, sinceMs, bucket);
	}

	async prune(olderThanMs: number): Promise<void> {
		await this.db.prepare('DELETE FROM agent_samples WHERE ts < ?').run(olderThanMs);
	}
}
