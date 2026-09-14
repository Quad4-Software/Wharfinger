import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '$lib/server/store/db';
import { JobQueue } from '$lib/server/jobs/queue';

function queue(): JobQueue {
	return new JobQueue(openDb(mkdtempSync(join(tmpdir(), 'wharfinger-jobs-'))));
}

const spec = { image: 'app:latest' };

describe('JobQueue enqueue', () => {
	it('dedupes on job_key', () => {
		const q = queue();
		const a = q.enqueue({ kind: 'deploy', target: 'agent-1', spec, jobKey: 'k1' });
		const b = q.enqueue({ kind: 'deploy', target: 'agent-1', spec, jobKey: 'k1' });
		expect(a.job.id).toBe(b.job.id);
		expect(q.list()).toHaveLength(1);
	});

	it('rejects oversized specs', () => {
		const q = queue();
		expect(() => q.enqueue({ kind: 'deploy', spec: { pad: 'x'.repeat(70 * 1024) } })).toThrow();
	});
});

describe('JobQueue claim', () => {
	it('hands the job to exactly one claimer', () => {
		const q = queue();
		q.enqueue({ kind: 'deploy', target: 'a1', spec });
		const c1 = q.claim('deploy', 'a1');
		expect(c1).not.toBeNull();
		expect(c1!.lease).toBeTruthy();
		expect(q.claim('deploy', 'a1')).toBeNull();
	});

	it('claims FIFO and respects the target', () => {
		const q = queue();
		const j1 = q.enqueue({ kind: 'deploy', target: 'a1', spec: { n: 1 } }).job;
		q.enqueue({ kind: 'deploy', target: 'a2', spec: { n: 2 } });
		expect(q.claim('deploy', 'a2')!.id).not.toBe(j1.id);
		expect(q.claim('deploy', 'a1')!.id).toBe(j1.id);
	});

	it('does not hand targeted jobs to other agents', () => {
		const q = queue();
		q.enqueue({ kind: 'deploy', target: 'a1', spec });
		expect(q.claim('deploy', 'a2')).toBeNull();
	});

	it('hands untargeted jobs to anyone', () => {
		const q = queue();
		q.enqueue({ kind: 'agent-task', spec });
		expect(q.claim('agent-task', 'anyone')).not.toBeNull();
	});
});

describe('JobQueue lease lifecycle', () => {
	it('only the lease owner can start and finish', () => {
		const q = queue();
		const job = q.enqueue({ kind: 'deploy', target: 'a1', spec }).job;
		const c = q.claim('deploy', 'a1')!;
		expect(q.start(job.id, 'wrong-lease')).toBe(false);
		expect(q.start(job.id, c.lease)).toBe(true);
		expect(q.succeed(job.id, 'wrong-lease')).toBe(false);
		expect(q.succeed(job.id, c.lease, { ok: 1 })).toBe(true);
		expect(q.get(job.id)!.status).toBe('succeeded');
	});

	it('heartbeat extends the lease for the owner only', () => {
		const q = queue();
		q.enqueue({ kind: 'deploy', target: 'a1', spec });
		const c = q.claim('deploy', 'a1', 60_000)!;
		expect(q.heartbeat(c.id, 'nope')).toBe(false);
		expect(q.heartbeat(c.id, c.lease)).toBe(true);
	});

	it('progress appends a bounded log tail', () => {
		const q = queue();
		q.enqueue({ kind: 'deploy', target: 'a1', spec });
		const c = q.claim('deploy', 'a1')!;
		expect(q.progress(c.id, c.lease, 'step one\n')).toBe(true);
		expect(q.progress(c.id, 'bad', 'nope\n')).toBe(false);
		expect(q.progress(c.id, c.lease, 'step two\n')).toBe(true);
		expect(q.get(c.id)!.log).toBe('step one\nstep two\n');
	});
});

describe('JobQueue failure and recovery', () => {
	it('fail requeues while attempts remain, then lands failed', () => {
		const q = queue();
		const job = q.enqueue({ kind: 'deploy', target: 'a1', spec, maxAttempts: 2 }).job;
		const c1 = q.claim('deploy', 'a1')!;
		expect(q.fail(c1.id, c1.lease, { err: 'boom' }).status).toBe('queued');
		const c2 = q.claim('deploy', 'a1')!;
		expect(c2.attempt).toBe(2);
		expect(q.fail(c2.id, c2.lease, { err: 'boom' }).status).toBe('failed');
		expect(q.get(job.id)!.status).toBe('failed');
	});

	it('rolled_back is terminal without retry', () => {
		const q = queue();
		q.enqueue({ kind: 'deploy', target: 'a1', spec });
		const c = q.claim('deploy', 'a1')!;
		expect(q.fail(c.id, c.lease, {}, { rolledBack: true }).status).toBe('rolled_back');
		expect(q.claim('deploy', 'a1')).toBeNull();
	});

	it('stale claimed jobs requeue, stale running jobs go unknown', () => {
		const q = queue();
		q.enqueue({ kind: 'deploy', target: 'a1', spec });
		const c1 = q.claim('deploy', 'a1', 1)!;
		const j2 = q.enqueue({ kind: 'deploy', target: 'a1', spec }).job;
		const c2 = q.claim('deploy', 'a1', 1)!;
		q.start(c2.id, c2.lease);

		expect(c2.id).toBe(j2.id); // FIFO: second claim takes the second job
		const r = q.recover(Date.now() + 10_000);
		expect(r.requeued).toBe(1);
		expect(r.unknown).toBe(1);
		expect(q.get(c1.id)!.status).toBe('queued');
		expect(q.get(c2.id)!.status).toBe('unknown');
	});

	it('exhausted stale claims also go unknown', () => {
		const q = queue();
		q.enqueue({ kind: 'deploy', target: 'a1', spec, maxAttempts: 1 });
		q.claim('deploy', 'a1', 1);
		const r = q.recover(Date.now() + 10_000);
		expect(r.requeued).toBe(0);
		expect(r.unknown).toBe(1);
	});

	it('reconcile resolves unknown jobs and ignores live ones', () => {
		const q = queue();
		q.enqueue({ kind: 'deploy', target: 'a1', spec });
		const c = q.claim('deploy', 'a1', 1)!;
		q.start(c.id, c.lease);
		q.recover(Date.now() + 10_000);
		expect(q.reconcile(c.id, 'succeeded', { note: 'agent saw it finish' })).toBe(true);
		expect(q.get(c.id)!.status).toBe('succeeded');

		const live = q.enqueue({ kind: 'deploy', target: 'a1', spec }).job;
		expect(q.reconcile(live.id, 'failed')).toBe(false);
		expect(q.get(live.id)!.status).toBe('queued');
	});
});

describe('JobQueue prune', () => {
	it('removes old terminal jobs, keeps unknown', () => {
		const q = queue();
		q.enqueue({ kind: 'deploy', target: 'a1', spec });
		const c = q.claim('deploy', 'a1')!;
		q.succeed(c.id, c.lease);
		const stale = Date.now() + 1000;
		expect(q.prune(stale)).toBe(1);
		expect(q.claim('deploy', 'a1', 1)).toBeNull(); // queue empty now
	});
});
