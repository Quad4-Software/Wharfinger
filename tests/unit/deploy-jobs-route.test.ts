import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { Runtime } from '$lib/server/runtime';
import type { PublicUser } from '$lib/shared/auth';

const ref = vi.hoisted(() => ({ rt: undefined as unknown as Runtime }));

vi.mock('$lib/server/runtime', async () => {
	process.env.WHARFINGER_SECRET_KEY = 'jobs-route-test-key';
	const { mkdtempSync } = await import('node:fs');
	const { join } = await import('node:path');
	const { tmpdir } = await import('node:os');
	const dir = mkdtempSync(join(tmpdir(), 'q4s-jobs-'));
	process.env.WHARFINGER_DATA_DIR = dir;
	const { openDb } = await import('$lib/server/store/db');
	const { JobQueue } = await import('$lib/server/jobs/queue');
	const { AgentStore } = await import('$lib/server/ingress/agents');
	const db = openDb(dir);
	ref.rt = {
		jobs: new JobQueue(db),
		agents: new AgentStore(db),
		config: { ingress: { online_seconds: 90 } },
		db
	} as unknown as Runtime;
	return { getRuntime: () => ref.rt };
});

const { GET } = await import('../../src/routes/admin/api/deploy/jobs/+server');

const admin = { id: 1, username: 'root', role: 'admin' } as PublicUser;

function event(query = ''): RequestEvent {
	return {
		locals: { user: admin, perms: new Set(['deploy.view']) },
		url: new URL(`http://test/admin/api/deploy/jobs${query}`)
	} as unknown as RequestEvent;
}

describe('deploy jobs route', () => {
	it('requires deploy.view', async () => {
		await expect(
			GET({
				locals: {},
				url: new URL('http://test/admin/api/deploy/jobs')
			} as never)
		).rejects.toMatchObject({ status: 401 });
	});

	it('marks queued jobs with a waiting reason', async () => {
		const agents = ref.rt.agents;
		const offline = (await agents.create('off-host', null)).id;
		const online = (await agents.create('on-host', null)).id;
		const revoked = (await agents.create('dead-host', null)).id;
		await agents.revoke(revoked);
		// on-host checked in just now; off-host never did.
		await ref.rt.db
			.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?')
			.run(Date.now(), online);

		await ref.rt.jobs.enqueue({ kind: 'deploy', target: offline, spec: {} });
		await ref.rt.jobs.enqueue({
			kind: 'deploy',
			target: online,
			spec: {},
			notBefore: Date.now() + 3600_000
		});
		await ref.rt.jobs.enqueue({ kind: 'deploy', target: online, spec: {} });
		await ref.rt.jobs.enqueue({ kind: 'deploy', target: revoked, spec: {} });

		const res = await GET(event() as never);
		const body = (await res.json()) as {
			jobs: {
				target: string | null;
				status: string;
				waitingReason: string | null;
				notBefore: number | null;
			}[];
		};
		const by = (t: string | null, nb: boolean) =>
			body.jobs.find((j) => j.target === t && (nb ? j.notBefore !== null : j.notBefore === null));
		expect(by(offline, false)?.waitingReason).toBe('agent offline');
		expect(by(online, true)?.waitingReason).toBe('scheduled');
		expect(by(online, false)?.waitingReason).toBeNull();
		expect(by(revoked, false)?.waitingReason).toBe('agent revoked');
	});

	it('filters by status param', async () => {
		const res = await GET(event('?status=succeeded') as never);
		const body = (await res.json()) as { jobs: { status: string }[] };
		expect(body.jobs.every((j) => j.status === 'succeeded')).toBe(true);
	});
});
