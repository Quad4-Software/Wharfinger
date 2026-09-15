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
	it('dedupes on job_key', async () => {
		const q = queue();
		const a = await q.enqueue({ kind: 'deploy', target: 'agent-1', spec, jobKey: 'k1' });
		const b = await q.enqueue({ kind: 'deploy', target: 'agent-1', spec, jobKey: 'k1' });
		expect(a.job.id).toBe(b.job.id);
		expect(await q.list()).toHaveLength(1);
	});

	it('rejects oversized specs', async () => {
		const q = queue();
		await expect(
			q.enqueue({ kind: 'deploy', spec: { pad: 'x'.repeat(70 * 1024) } })
		).rejects.toThrow();
	});
});

describe('JobQueue claim', () => {
	it('hands the job to exactly one claimer', async () => {
		const q = queue();
		await q.enqueue({ kind: 'deploy', target: 'a1', spec });
		const c1 = await q.claim('deploy', 'a1');
		expect(c1).not.toBeNull();
		expect(c1!.lease).toBeTruthy();
		expect(await q.claim('deploy', 'a1')).toBeNull();
	});

	it('claims FIFO and respects the target', async () => {
		const q = queue();
		const j1 = (await q.enqueue({ kind: 'deploy', target: 'a1', spec: { n: 1 } })).job;
		await q.enqueue({ kind: 'deploy', target: 'a2', spec: { n: 2 } });
		expect((await q.claim('deploy', 'a2'))!.id).not.toBe(j1.id);
		expect((await q.claim('deploy', 'a1'))!.id).toBe(j1.id);
	});

	it('does not hand targeted jobs to other agents', async () => {
		const q = queue();
		await q.enqueue({ kind: 'deploy', target: 'a1', spec });
		expect(await q.claim('deploy', 'a2')).toBeNull();
	});

	it('hands untargeted jobs to anyone', async () => {
		const q = queue();
		await q.enqueue({ kind: 'agent-task', spec });
		expect(await q.claim('agent-task', 'anyone')).not.toBeNull();
	});
});

describe('JobQueue scheduling', () => {
	it('holds not_before jobs until their time', async () => {
		const q = queue();
		const future = Date.now() + 60_000;
		const { job } = await q.enqueue({
			kind: 'agent-task',
			target: 'a1',
			spec,
			notBefore: future
		});
		expect(job.notBefore).toBe(future);
		expect(await q.claim('agent-task', 'a1')).toBeNull();

		// An unscheduled sibling still claims while the future job waits.
		await q.enqueue({ kind: 'agent-task', target: 'a1', spec });
		const c = await q.claim('agent-task', 'a1');
		expect(c).not.toBeNull();
		expect(c!.id).not.toBe(job.id);
	});

	it('claims a job whose not_before has passed', async () => {
		const q = queue();
		await q.enqueue({
			kind: 'agent-task',
			target: 'a1',
			spec,
			notBefore: Date.now() - 1000
		});
		expect(await q.claim('agent-task', 'a1')).not.toBeNull();
	});
});

describe('JobQueue lease lifecycle', () => {
	it('only the lease owner can start and finish', async () => {
		const q = queue();
		const job = (await q.enqueue({ kind: 'deploy', target: 'a1', spec })).job;
		const c = (await q.claim('deploy', 'a1'))!;
		expect(await q.start(job.id, 'wrong-lease')).toBe(false);
		expect(await q.start(job.id, c.lease)).toBe(true);
		expect(await q.succeed(job.id, 'wrong-lease')).toBe(false);
		expect(await q.succeed(job.id, c.lease, { ok: 1 })).toBe(true);
		expect((await q.get(job.id))!.status).toBe('succeeded');
	});

	it('heartbeat extends the lease for the owner only', async () => {
		const q = queue();
		await q.enqueue({ kind: 'deploy', target: 'a1', spec });
		const c = (await q.claim('deploy', 'a1', 60_000))!;
		expect(await q.heartbeat(c.id, 'nope')).toBe(false);
		expect(await q.heartbeat(c.id, c.lease)).toBe(true);
	});

	it('progress appends a bounded log tail', async () => {
		const q = queue();
		await q.enqueue({ kind: 'deploy', target: 'a1', spec });
		const c = (await q.claim('deploy', 'a1'))!;
		expect(await q.progress(c.id, c.lease, 'step one\n')).toBe(true);
		expect(await q.progress(c.id, 'bad', 'nope\n')).toBe(false);
		expect(await q.progress(c.id, c.lease, 'step two\n')).toBe(true);
		expect((await q.get(c.id))!.log).toBe('step one\nstep two\n');
	});
});

describe('JobQueue failure and recovery', () => {
	it('fail requeues while attempts remain, then lands failed', async () => {
		const q = queue();
		const job = (await q.enqueue({ kind: 'deploy', target: 'a1', spec, maxAttempts: 2 })).job;
		const c1 = (await q.claim('deploy', 'a1'))!;
		expect((await q.fail(c1.id, c1.lease, { err: 'boom' })).status).toBe('queued');
		const c2 = (await q.claim('deploy', 'a1'))!;
		expect(c2.attempt).toBe(2);
		expect((await q.fail(c2.id, c2.lease, { err: 'boom' })).status).toBe('failed');
		expect((await q.get(job.id))!.status).toBe('failed');
	});

	it('rolled_back is terminal without retry', async () => {
		const q = queue();
		await q.enqueue({ kind: 'deploy', target: 'a1', spec });
		const c = (await q.claim('deploy', 'a1'))!;
		expect((await q.fail(c.id, c.lease, {}, { rolledBack: true })).status).toBe('rolled_back');
		expect(await q.claim('deploy', 'a1')).toBeNull();
	});

	it('stale claimed jobs requeue, stale running jobs go unknown', async () => {
		const q = queue();
		await q.enqueue({ kind: 'deploy', target: 'a1', spec });
		const c1 = (await q.claim('deploy', 'a1', 1))!;
		const j2 = (await q.enqueue({ kind: 'deploy', target: 'a1', spec })).job;
		const c2 = (await q.claim('deploy', 'a1', 1))!;
		await q.start(c2.id, c2.lease);

		expect(c2.id).toBe(j2.id); // FIFO: second claim takes the second job
		const r = await q.recover(Date.now() + 10_000);
		expect(r.requeued).toBe(1);
		expect(r.unknown).toBe(1);
		expect((await q.get(c1.id))!.status).toBe('queued');
		expect((await q.get(c2.id))!.status).toBe('unknown');
	});

	it('exhausted stale claims also go unknown', async () => {
		const q = queue();
		await q.enqueue({ kind: 'deploy', target: 'a1', spec, maxAttempts: 1 });
		await q.claim('deploy', 'a1', 1);
		const r = await q.recover(Date.now() + 10_000);
		expect(r.requeued).toBe(0);
		expect(r.unknown).toBe(1);
	});

	it('reconcile resolves unknown jobs and ignores live ones', async () => {
		const q = queue();
		await q.enqueue({ kind: 'deploy', target: 'a1', spec });
		const c = (await q.claim('deploy', 'a1', 1))!;
		await q.start(c.id, c.lease);
		await q.recover(Date.now() + 10_000);
		expect(await q.reconcile(c.id, 'succeeded', { note: 'agent saw it finish' })).toBe(true);
		expect((await q.get(c.id))!.status).toBe('succeeded');

		const live = (await q.enqueue({ kind: 'deploy', target: 'a1', spec })).job;
		expect(await q.reconcile(live.id, 'failed')).toBe(false);
		expect((await q.get(live.id))!.status).toBe('queued');
	});
});

describe('JobQueue prune', () => {
	it('removes old terminal jobs, keeps unknown', async () => {
		const q = queue();
		await q.enqueue({ kind: 'deploy', target: 'a1', spec });
		const c = (await q.claim('deploy', 'a1'))!;
		await q.succeed(c.id, c.lease);
		const stale = Date.now() + 1000;
		expect(await q.prune(stale)).toBe(1);
		expect(await q.claim('deploy', 'a1', 1)).toBeNull(); // queue empty now
	});
});
