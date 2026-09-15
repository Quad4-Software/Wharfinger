import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { isTerminal, JOB_STATUSES } from '$lib/shared/jobs';
import type { ClaimedJob, Job, JobKind, JobStatus } from '$lib/shared/jobs';
import { asDb, type Db } from '$lib/server/store/driver';

interface JobRow {
	id: number;
	job_key: string;
	kind: string;
	target: string | null;
	status: string;
	spec: string;
	result: string | null;
	log: string | null;
	lease_owner: string | null;
	lease_until: number | null;
	not_before: number | null;
	attempts: number;
	max_attempts: number;
	created_at: number;
	updated_at: number;
}

function toJob(r: JobRow): Job {
	return {
		id: r.id,
		jobKey: r.job_key,
		kind: r.kind as JobKind,
		target: r.target,
		status: r.status as JobStatus,
		spec: r.spec,
		result: r.result,
		log: r.log,
		leaseOwner: r.lease_owner,
		leaseUntil: r.lease_until,
		notBefore: r.not_before,
		attempts: r.attempts,
		maxAttempts: r.max_attempts,
		createdAt: r.created_at,
		updatedAt: r.updated_at
	};
}

const MAX_SPEC_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_LOG_BYTES = 512 * 1024;
const DEFAULT_LEASE_MS = 120_000;
const TERMINAL: JobStatus[] = JOB_STATUSES.filter(isTerminal);

/**
 * Durable job queue over the Db driver. Every transition is a single
 * conditional UPDATE or a transaction, so concurrent claimers cannot
 * split ownership. See .agents/skills/job-queue for invariants.
 */
export class JobQueue {
	private readonly db: Db;

	constructor(db: Db | DatabaseSync) {
		this.db = asDb(db);
	}

	/**
	 * Enqueue a job with a frozen spec snapshot. job_key dedupes:
	 * re-enqueueing the same key returns the existing job instead of a
	 * duplicate, which makes triggers idempotent for free.
	 */
	async enqueue(opts: {
		kind: JobKind;
		target?: string | null;
		spec: unknown;
		jobKey?: string;
		maxAttempts?: number;
		notBefore?: number;
	}): Promise<{ job: Job; created: boolean }> {
		const spec = JSON.stringify(opts.spec);
		if (spec.length > MAX_SPEC_BYTES) throw new Error('job spec too large');
		const jobKey = opts.jobKey ?? randomBytes(16).toString('base64url');
		const now = Date.now();
		await this.db
			.prepare(
				`INSERT OR IGNORE INTO jobs (job_key, kind, target, status, spec, attempts, max_attempts, not_before, created_at, updated_at)
				 VALUES (?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?)`
			)
			.run(
				jobKey,
				opts.kind,
				opts.target ?? null,
				spec,
				opts.maxAttempts ?? 3,
				opts.notBefore ?? null,
				now,
				now
			);
		const row = (await this.db
			.prepare('SELECT * FROM jobs WHERE job_key = ?')
			.get(jobKey)) as unknown as JobRow;
		return { job: toJob(row), created: row.created_at === now };
	}

	/**
	 * Atomically claim the oldest queued job for a target. The lease
	 * owner is a fresh random token: only its holder can heartbeat or
	 * finish the job, which makes stolen job ids useless. The pick +
	 * conditional update run inside one transaction so two claimers
	 * cannot take the same row; the second UPDATE matches zero rows
	 * once the first commits.
	 */
	async claim(
		kind: JobKind,
		target: string | null,
		leaseMs = DEFAULT_LEASE_MS
	): Promise<ClaimedJob | null> {
		const owner = randomBytes(16).toString('base64url');
		const now = Date.now();
		return this.db.tx(async (tx) => {
			const cand = (await tx
				.prepare(
					`SELECT id FROM jobs
					 WHERE status = 'queued' AND kind = ? AND (target = ? OR target IS NULL)
					   AND (not_before IS NULL OR not_before <= ?)
					 ORDER BY id LIMIT 1`
				)
				.get(kind, target, now)) as { id: number } | undefined;
			if (!cand) return null;
			const row = (await tx
				.prepare(
					`UPDATE jobs SET status = 'claimed', lease_owner = ?, lease_until = ?,
						attempts = attempts + 1, updated_at = ?
					 WHERE id = ? AND status = 'queued'
					 RETURNING *`
				)
				.get(owner, now + leaseMs, now, cand.id)) as unknown as JobRow | undefined;
			if (!row) return null;
			return {
				id: row.id,
				kind: row.kind as JobKind,
				spec: row.spec,
				lease: owner,
				leaseUntil: row.lease_until ?? now + leaseMs,
				attempt: row.attempts
			};
		});
	}

	async pending(target: string | null, kind?: JobKind): Promise<number> {
		const row = (await (kind
			? this.db
					.prepare(
						"SELECT COUNT(*) c FROM jobs WHERE status = 'queued' AND kind = ? AND (target = ? OR target IS NULL)"
					)
					.get(kind, target)
			: this.db
					.prepare(
						"SELECT COUNT(*) c FROM jobs WHERE status = 'queued' AND (target = ? OR target IS NULL)"
					)
					.get(target))) as { c: number } | undefined;
		return row?.c ?? 0;
	}

	/** Extend the lease; only the owner token may heartbeat. */
	async heartbeat(jobId: number, lease: string, leaseMs = DEFAULT_LEASE_MS): Promise<boolean> {
		const now = Date.now();
		return (
			Number(
				(
					await this.db
						.prepare(
							`UPDATE jobs SET lease_until = ?, updated_at = ?
							 WHERE id = ? AND lease_owner = ? AND status IN ('claimed', 'running')`
						)
						.run(now + leaseMs, now, jobId, lease)
				).changes
			) === 1
		);
	}

	/**
	 * Append a bounded progress/log chunk. The log keeps its tail
	 * under MAX_LOG_BYTES so a chatty build cannot grow the row
	 * without bound; only the lease owner may write. substr() is not
	 * portable, so the tail trim happens in code inside the same
	 * lease-guarded transaction.
	 */
	async progress(jobId: number, lease: string, chunk: string): Promise<boolean> {
		if (!chunk) return true;
		const clipped = chunk.slice(0, MAX_LOG_BYTES);
		const now = Date.now();
		return this.db.tx(async (tx) => {
			const cond = "id = ? AND lease_owner = ? AND status IN ('claimed', 'running')";
			const cur = (await tx.prepare(`SELECT log FROM jobs WHERE ${cond}`).get(jobId, lease)) as
				{ log: string | null } | undefined;
			if (!cur) return false;
			const next = ((cur.log ?? '') + clipped).slice(-MAX_LOG_BYTES);
			const r = await tx
				.prepare(`UPDATE jobs SET log = ?, updated_at = ? WHERE ${cond}`)
				.run(next, now, jobId, lease);
			return Number(r.changes) === 1;
		});
	}

	/** Transition claimed -> running; only the owner may start. */
	async start(jobId: number, lease: string): Promise<boolean> {
		return (
			Number(
				(
					await this.db
						.prepare(
							`UPDATE jobs SET status = 'running', updated_at = ?
							 WHERE id = ? AND lease_owner = ? AND status = 'claimed'`
						)
						.run(Date.now(), jobId, lease)
				).changes
			) === 1
		);
	}

	private async finish(
		jobId: number,
		lease: string,
		status: JobStatus,
		result: unknown
	): Promise<boolean> {
		const r = JSON.stringify(result ?? null);
		if (r.length > MAX_RESULT_BYTES) throw new Error('job result too large');
		return (
			Number(
				(
					await this.db
						.prepare(
							`UPDATE jobs SET status = ?, result = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
							 WHERE id = ? AND lease_owner = ? AND status IN ('claimed', 'running')`
						)
						.run(status, r, Date.now(), jobId, lease)
				).changes
			) === 1
		);
	}

	async succeed(jobId: number, lease: string, result?: unknown): Promise<boolean> {
		return this.finish(jobId, lease, 'succeeded', result);
	}

	/**
	 * Fail a job. Retries requeue while attempts remain; the final
	 * failure lands in 'failed'. rolled_back is a terminal success-
	 * adjacent state for deploy jobs that restored a prior release.
	 */
	async fail(
		jobId: number,
		lease: string,
		result?: unknown,
		opts: { rolledBack?: boolean } = {}
	): Promise<{ status: JobStatus }> {
		const row = (await this.db
			.prepare('SELECT attempts, max_attempts FROM jobs WHERE id = ? AND lease_owner = ?')
			.get(jobId, lease)) as { attempts: number; max_attempts: number } | undefined;
		if (!row) return { status: 'unknown' };
		if (opts.rolledBack) {
			await this.finish(jobId, lease, 'rolled_back', result);
			return { status: 'rolled_back' };
		}
		if (row.attempts < row.max_attempts) {
			const r = JSON.stringify(result ?? null);
			await this.db
				.prepare(
					`UPDATE jobs SET status = 'queued', result = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
					 WHERE id = ? AND lease_owner = ? AND status IN ('claimed', 'running')`
				)
				.run(r.length > MAX_RESULT_BYTES ? '"result too large"' : r, Date.now(), jobId, lease);
			return { status: 'queued' };
		}
		await this.finish(jobId, lease, 'failed', result);
		return { status: 'failed' };
	}

	/**
	 * Lease recovery on startup and the periodic sweep. A stale
	 * 'claimed' job never started work, so it requeues safely while
	 * attempts remain. A stale 'running' job may have done anything:
	 * it goes to 'unknown' for reconciliation rather than a blind
	 * requeue that could double-execute.
	 */
	async recover(now = Date.now()): Promise<{ requeued: number; unknown: number }> {
		const requeued = Number(
			(
				await this.db
					.prepare(
						`UPDATE jobs SET status = 'queued', lease_owner = NULL, lease_until = NULL, updated_at = ?
						 WHERE status = 'claimed' AND lease_until < ? AND attempts < max_attempts`
					)
					.run(now, now)
			).changes
		);
		const unknown = Number(
			(
				await this.db
					.prepare(
						`UPDATE jobs SET status = 'unknown', updated_at = ?
						 WHERE status IN ('claimed', 'running') AND lease_until < ?`
					)
					.run(now, now)
			).changes
		);
		return { requeued, unknown };
	}

	/**
	 * Reconcile a stale job from the executor's report. The agent
	 * restarts and reports its observed outcome; the hub records it
	 * without ever re-running the job.
	 */
	async reconcile(
		jobId: number,
		outcome: 'succeeded' | 'failed' | 'rolled_back',
		result?: unknown
	): Promise<boolean> {
		const r = JSON.stringify(result ?? null);
		return (
			Number(
				(
					await this.db
						.prepare(
							`UPDATE jobs SET status = ?, result = ?, updated_at = ? WHERE id = ? AND status = 'unknown'`
						)
						.run(outcome, r.length > MAX_RESULT_BYTES ? '"result too large"' : r, Date.now(), jobId)
				).changes
			) === 1
		);
	}

	async get(id: number): Promise<Job | null> {
		const row = (await this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)) as
			JobRow | undefined;
		return row ? toJob(row) : null;
	}

	async byKey(jobKey: string): Promise<Job | null> {
		const row = (await this.db.prepare('SELECT * FROM jobs WHERE job_key = ?').get(jobKey)) as
			JobRow | undefined;
		return row ? toJob(row) : null;
	}

	async list(
		opts: { status?: JobStatus; kind?: JobKind; target?: string; limit?: number } = {}
	): Promise<Job[]> {
		const parts: string[] = [];
		const args: (string | number)[] = [];
		if (opts.status) {
			parts.push('status = ?');
			args.push(opts.status);
		}
		if (opts.kind) {
			parts.push('kind = ?');
			args.push(opts.kind);
		}
		if (opts.target) {
			parts.push('target = ?');
			args.push(opts.target);
		}
		const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
		return (
			(await this.db
				.prepare(`SELECT * FROM jobs ${where} ORDER BY id DESC LIMIT ?`)
				.all(...args, opts.limit ?? 100)) as unknown as JobRow[]
		).map(toJob);
	}

	/** Prune terminal jobs past retention; unknown stays for review. */
	async prune(olderThan: number): Promise<number> {
		const statuses = TERMINAL.map(() => '?').join(',');
		return Number(
			(
				await this.db
					.prepare(`DELETE FROM jobs WHERE status IN (${statuses}) AND updated_at < ?`)
					.run(...TERMINAL, olderThan)
			).changes
		);
	}
}
