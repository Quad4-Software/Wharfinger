import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { isTerminal, JOB_STATUSES } from '$lib/shared/jobs';
import type { ClaimedJob, Job, JobKind, JobStatus } from '$lib/shared/jobs';

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
 * Durable job queue over SQLite. Every transition is a single
 * conditional UPDATE or a transaction, so concurrent claimers cannot
 * split ownership. See .agents/skills/job-queue for invariants.
 */
export class JobQueue {
	constructor(private readonly db: DatabaseSync) {}

	/**
	 * Enqueue a job with a frozen spec snapshot. job_key dedupes:
	 * re-enqueueing the same key returns the existing job instead of a
	 * duplicate, which makes triggers idempotent for free.
	 */
	enqueue(opts: {
		kind: JobKind;
		target?: string | null;
		spec: unknown;
		jobKey?: string;
		maxAttempts?: number;
	}): { job: Job; created: boolean } {
		const spec = JSON.stringify(opts.spec);
		if (spec.length > MAX_SPEC_BYTES) throw new Error('job spec too large');
		const jobKey = opts.jobKey ?? randomBytes(16).toString('base64url');
		const now = Date.now();
		this.db
			.prepare(
				`INSERT OR IGNORE INTO jobs (job_key, kind, target, status, spec, attempts, max_attempts, created_at, updated_at)
				 VALUES (?, ?, ?, 'queued', ?, 0, ?, ?, ?)`
			)
			.run(jobKey, opts.kind, opts.target ?? null, spec, opts.maxAttempts ?? 3, now, now);
		const row = this.db
			.prepare('SELECT * FROM jobs WHERE job_key = ?')
			.get(jobKey) as unknown as JobRow;
		return { job: toJob(row), created: row.created_at === now };
	}

	/**
	 * Atomically claim the oldest queued job for a target. The lease
	 * owner is a fresh random token: only its holder can heartbeat or
	 * finish the job, which makes stolen job ids useless.
	 */
	claim(kind: JobKind, target: string | null, leaseMs = DEFAULT_LEASE_MS): ClaimedJob | null {
		const owner = randomBytes(16).toString('base64url');
		const now = Date.now();
		const row = this.db
			.prepare(
				`UPDATE jobs SET status = 'claimed', lease_owner = ?, lease_until = ?,
					attempts = attempts + 1, updated_at = ?
				 WHERE id = (
					SELECT id FROM jobs
					WHERE status = 'queued' AND kind = ? AND (target = ? OR target IS NULL)
					ORDER BY id LIMIT 1
				 )
				 RETURNING *`
			)
			.get(owner, now + leaseMs, now, kind, target) as JobRow | undefined;
		if (!row) return null;
		return {
			id: row.id,
			kind: row.kind as JobKind,
			spec: row.spec,
			lease: owner,
			leaseUntil: row.lease_until ?? now + leaseMs,
			attempt: row.attempts
		};
	}

	pending(target: string | null, kind?: JobKind): number {
		const row = (
			kind
				? this.db
						.prepare(
							"SELECT COUNT(*) c FROM jobs WHERE status = 'queued' AND kind = ? AND (target = ? OR target IS NULL)"
						)
						.get(kind, target)
				: this.db
						.prepare(
							"SELECT COUNT(*) c FROM jobs WHERE status = 'queued' AND (target = ? OR target IS NULL)"
						)
						.get(target)
		) as { c: number };
		return row.c;
	}

	/** Extend the lease; only the owner token may heartbeat. */
	heartbeat(jobId: number, lease: string, leaseMs = DEFAULT_LEASE_MS): boolean {
		const now = Date.now();
		return (
			Number(
				this.db
					.prepare(
						`UPDATE jobs SET lease_until = ?, updated_at = ?
						 WHERE id = ? AND lease_owner = ? AND status IN ('claimed', 'running')`
					)
					.run(now + leaseMs, now, jobId, lease).changes
			) === 1
		);
	}

	/**
	 * Append a bounded progress/log chunk. The log keeps its tail
	 * under MAX_LOG_BYTES so a chatty build cannot grow the row
	 * without bound; only the lease owner may write.
	 */
	progress(jobId: number, lease: string, chunk: string): boolean {
		if (!chunk) return true;
		const now = Date.now();
		return (
			Number(
				this.db
					.prepare(
						`UPDATE jobs SET log = substr(COALESCE(log, '') || ?, -?), updated_at = ?
						 WHERE id = ? AND lease_owner = ? AND status IN ('claimed', 'running')`
					)
					.run(chunk.slice(0, MAX_LOG_BYTES), MAX_LOG_BYTES, now, jobId, lease).changes
			) === 1
		);
	}

	/** Transition claimed -> running; only the owner may start. */
	start(jobId: number, lease: string): boolean {
		return (
			Number(
				this.db
					.prepare(
						`UPDATE jobs SET status = 'running', updated_at = ?
						 WHERE id = ? AND lease_owner = ? AND status = 'claimed'`
					)
					.run(Date.now(), jobId, lease).changes
			) === 1
		);
	}

	private finish(jobId: number, lease: string, status: JobStatus, result: unknown): boolean {
		const r = JSON.stringify(result ?? null);
		if (r.length > MAX_RESULT_BYTES) throw new Error('job result too large');
		return (
			Number(
				this.db
					.prepare(
						`UPDATE jobs SET status = ?, result = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
						 WHERE id = ? AND lease_owner = ? AND status IN ('claimed', 'running')`
					)
					.run(status, r, Date.now(), jobId, lease).changes
			) === 1
		);
	}

	succeed(jobId: number, lease: string, result?: unknown): boolean {
		return this.finish(jobId, lease, 'succeeded', result);
	}

	/**
	 * Fail a job. Retries requeue while attempts remain; the final
	 * failure lands in 'failed'. rolled_back is a terminal success-
	 * adjacent state for deploy jobs that restored a prior release.
	 */
	fail(
		jobId: number,
		lease: string,
		result?: unknown,
		opts: { rolledBack?: boolean } = {}
	): { status: JobStatus } {
		const row = this.db
			.prepare('SELECT attempts, max_attempts FROM jobs WHERE id = ? AND lease_owner = ?')
			.get(jobId, lease) as { attempts: number; max_attempts: number } | undefined;
		if (!row) return { status: 'unknown' };
		if (opts.rolledBack) {
			this.finish(jobId, lease, 'rolled_back', result);
			return { status: 'rolled_back' };
		}
		if (row.attempts < row.max_attempts) {
			const r = JSON.stringify(result ?? null);
			this.db
				.prepare(
					`UPDATE jobs SET status = 'queued', result = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
					 WHERE id = ? AND lease_owner = ? AND status IN ('claimed', 'running')`
				)
				.run(r.length > MAX_RESULT_BYTES ? '"result too large"' : r, Date.now(), jobId, lease);
			return { status: 'queued' };
		}
		this.finish(jobId, lease, 'failed', result);
		return { status: 'failed' };
	}

	/**
	 * Lease recovery on startup and the periodic sweep. A stale
	 * 'claimed' job never started work, so it requeues safely while
	 * attempts remain. A stale 'running' job may have done anything:
	 * it goes to 'unknown' for reconciliation rather than a blind
	 * requeue that could double-execute.
	 */
	recover(now = Date.now()): { requeued: number; unknown: number } {
		const requeued = Number(
			this.db
				.prepare(
					`UPDATE jobs SET status = 'queued', lease_owner = NULL, lease_until = NULL, updated_at = ?
					 WHERE status = 'claimed' AND lease_until < ? AND attempts < max_attempts`
				)
				.run(now, now).changes
		);
		const unknown = Number(
			this.db
				.prepare(
					`UPDATE jobs SET status = 'unknown', updated_at = ?
					 WHERE status IN ('claimed', 'running') AND lease_until < ?`
				)
				.run(now, now).changes
		);
		return { requeued, unknown };
	}

	/**
	 * Reconcile a stale job from the executor's report. The agent
	 * restarts and reports its observed outcome; the hub records it
	 * without ever re-running the job.
	 */
	reconcile(
		jobId: number,
		outcome: 'succeeded' | 'failed' | 'rolled_back',
		result?: unknown
	): boolean {
		const r = JSON.stringify(result ?? null);
		return (
			Number(
				this.db
					.prepare(
						`UPDATE jobs SET status = ?, result = ?, updated_at = ? WHERE id = ? AND status = 'unknown'`
					)
					.run(outcome, r.length > MAX_RESULT_BYTES ? '"result too large"' : r, Date.now(), jobId)
					.changes
			) === 1
		);
	}

	get(id: number): Job | null {
		const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
		return row ? toJob(row) : null;
	}

	byKey(jobKey: string): Job | null {
		const row = this.db.prepare('SELECT * FROM jobs WHERE job_key = ?').get(jobKey) as
			JobRow | undefined;
		return row ? toJob(row) : null;
	}

	list(opts: { status?: JobStatus; kind?: JobKind; target?: string; limit?: number } = {}): Job[] {
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
			this.db
				.prepare(`SELECT * FROM jobs ${where} ORDER BY id DESC LIMIT ?`)
				.all(...args, opts.limit ?? 100) as unknown as JobRow[]
		).map(toJob);
	}

	/** Prune terminal jobs past retention; unknown stays for review. */
	prune(olderThan: number): number {
		const statuses = TERMINAL.map(() => '?').join(',');
		return Number(
			this.db
				.prepare(`DELETE FROM jobs WHERE status IN (${statuses}) AND updated_at < ?`)
				.run(...TERMINAL, olderThan).changes
		);
	}
}
