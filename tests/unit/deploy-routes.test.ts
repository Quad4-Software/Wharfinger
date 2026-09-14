import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { Runtime } from '$lib/server/runtime';

// Fake a runtime backed by real stores on a temp db, and stub the
// ingress gates so the route logic (lease checks, transitions,
// secrets scoping, settle) is what actually gets exercised.
const ref = vi.hoisted(() => ({ rt: undefined as unknown as Runtime }));

vi.mock('$lib/server/runtime', async () => {
	process.env.WHARFINGER_SECRET_KEY = 'route-test-key-material';
	const { mkdtempSync } = await import('node:fs');
	const { join } = await import('node:path');
	const { tmpdir } = await import('node:os');
	const dir = mkdtempSync(join(tmpdir(), 'q4s-routes-'));
	process.env.WHARFINGER_DATA_DIR = dir;
	const { openDb } = await import('$lib/server/store/db');
	const { JobQueue } = await import('$lib/server/jobs/queue');
	const { DeployStore } = await import('$lib/server/deploy/store');
	const db = openDb(dir);
	ref.rt = {
		jobs: new JobQueue(db),
		deploys: new DeployStore(db),
		agents: {},
		db
	} as unknown as Runtime;
	return { getRuntime: () => ref.rt };
});

vi.mock('$lib/server/ingress/http', async () => {
	const orig = await import('$lib/server/ingress/http');
	return {
		...(orig as object),
		bearerToken: () => 'tok',
		gate: () => ({ err: null, agent: { id: 'agent-1', pubkey: null } }),
		proofGate: () => null
	};
});

const { POST: claimJobs } = await import('../../src/routes/ingress/jobs/claim/+server');
const { POST: jobAction } = await import('../../src/routes/ingress/jobs/[id]/+server');
const { POST: jobSecrets } = await import('../../src/routes/ingress/jobs/[id]/secrets/+server');
const { POST: reconcile } = await import('../../src/routes/ingress/jobs/reconcile/+server');
const { triggerDeploy } = await import('$lib/server/deploy/trigger');

function event(path: string, body: unknown, params: Record<string, string> = {}): RequestEvent {
	return {
		params,
		url: new URL(`http://test${path}`),
		request: new Request(`http://test${path}`, {
			method: 'POST',
			body: JSON.stringify(body)
		})
	} as unknown as RequestEvent;
}

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

const GIT = { kind: 'git', url: 'https://git.example.com/org/app.git', ref: 'main' } as const;

describe('ingress job routes', () => {
	it('claim returns null when the queue is empty', async () => {
		const res = await claimJobs(event('/ingress/jobs/claim', {}) as never);
		expect(await json(res)).toEqual({ ok: true, job: null });
	});

	it('claim hands out a lease and the lifecycle endpoints honor it', async () => {
		ref.rt.jobs.enqueue({ jobKey: 'k1', kind: 'deploy', target: 'agent-1', spec: { x: 1 } });
		const claim = await json(await claimJobs(event('/ingress/jobs/claim', {}) as never));
		const job = claim.job as { id: number; lease: string };
		expect(job.lease).toBeTruthy();

		const started = await json(
			await jobAction(
				event(
					`/ingress/jobs/${job.id}`,
					{ lease: job.lease, action: 'start' },
					{ id: String(job.id) }
				) as never
			)
		);
		expect(started).toEqual({ ok: true });

		const prog = await json(
			await jobAction(
				event(
					`/ingress/jobs/${job.id}`,
					{ lease: job.lease, action: 'progress', chunk: '[build] step 1' },
					{ id: String(job.id) }
				) as never
			)
		);
		expect(prog).toEqual({ ok: true });
		expect(ref.rt.jobs.get(job.id)?.log).toContain('[build] step 1');
	});

	it('rejects lifecycle calls with a wrong lease', async () => {
		ref.rt.jobs.enqueue({ jobKey: 'k2', kind: 'deploy', target: 'agent-1', spec: {} });
		const claim = await json(await claimJobs(event('/ingress/jobs/claim', {}) as never));
		const job = claim.job as { id: number };
		const res = await json(
			await jobAction(
				event(
					`/ingress/jobs/${job.id}`,
					{ lease: 'forged', action: 'start' },
					{ id: String(job.id) }
				) as never
			)
		);
		expect(res).toEqual({ ok: false });
	});

	it('secrets requires the live lease and returns sealed env', async () => {
		const { app } = ref.rt.deploys.createApp({
			name: 'secapp',
			agentId: 'agent-1',
			source: GIT
		});
		ref.rt.deploys.setEnv(app.id, { TOKEN: 's3cret' });
		const { job } = triggerDeploy(ref.rt, app);
		const claim = await json(await claimJobs(event('/ingress/jobs/claim', {}) as never));
		const claimed = claim.job as { id: number; lease: string };
		expect(claimed.id).toBe(job.id);

		const denied = await jobSecrets(
			event(`/ingress/jobs/${job.id}/secrets`, { lease: 'wrong' }, { id: String(job.id) }) as never
		);
		expect(denied.status).toBe(403);

		const res = await json(
			await jobSecrets(
				event(
					`/ingress/jobs/${job.id}/secrets`,
					{ lease: claimed.lease },
					{ id: String(job.id) }
				) as never
			)
		);
		expect((res.env as Record<string, string>).TOKEN).toBe('s3cret');
	});

	it('succeed settles the release live through the trigger', async () => {
		const { app } = ref.rt.deploys.createApp({
			name: 'settleapp',
			agentId: 'agent-1',
			source: GIT
		});
		const { job, releaseId } = triggerDeploy(ref.rt, app);
		const claim = await json(await claimJobs(event('/ingress/jobs/claim', {}) as never));
		const claimed = claim.job as { id: number; lease: string };
		expect(claimed.id).toBe(job.id);

		const res = await json(
			await jobAction(
				event(
					`/ingress/jobs/${job.id}`,
					{ lease: claimed.lease, action: 'succeed', result: { commit: 'abc', image: 'x:1' } },
					{ id: String(job.id) }
				) as never
			)
		);
		expect(res).toEqual({ ok: true });
		expect(ref.rt.deploys.release(releaseId!)?.status).toBe('live');
	});

	it('reconcile only applies to unknown jobs owned by the agent', async () => {
		ref.rt.jobs.enqueue({ jobKey: 'k3', kind: 'deploy', target: 'agent-1', spec: {} });
		const claim = await json(await claimJobs(event('/ingress/jobs/claim', {}) as never));
		const job = claim.job as { id: number; lease: string };
		// A running job whose lease expired goes unknown on recovery:
		// the executor may have done anything before it died.
		await jobAction(
			event(
				`/ingress/jobs/${job.id}`,
				{ lease: job.lease, action: 'start' },
				{ id: String(job.id) }
			) as never
		);
		ref.rt.jobs.recover(Date.now() + 200_000);
		expect(ref.rt.jobs.get(job.id)?.status).toBe('unknown');

		const res = await json(
			await reconcile(
				event('/ingress/jobs/reconcile', { jobs: [{ id: job.id, outcome: 'failed' }] }) as never
			)
		);
		expect(res).toEqual({ ok: true, applied: 1 });
		expect(ref.rt.jobs.get(job.id)?.status).toBe('failed');

		// A second report on the now-terminal job applies nothing.
		const again = await json(
			await reconcile(
				event('/ingress/jobs/reconcile', { jobs: [{ id: job.id, outcome: 'succeeded' }] }) as never
			)
		);
		expect(again).toEqual({ ok: true, applied: 0 });
	});
});
