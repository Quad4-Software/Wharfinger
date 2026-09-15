import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { Runtime } from '$lib/server/runtime';
import type { PublicUser } from '$lib/shared/auth';

const ref = vi.hoisted(() => ({ rt: undefined as unknown as Runtime }));

vi.mock('$lib/server/runtime', async () => {
	process.env.WHARFINGER_SECRET_KEY = 'task-route-test-key';
	const { mkdtempSync } = await import('node:fs');
	const { join } = await import('node:path');
	const { tmpdir } = await import('node:os');
	const dir = mkdtempSync(join(tmpdir(), 'q4s-task-'));
	process.env.WHARFINGER_DATA_DIR = dir;
	const { openDb } = await import('$lib/server/store/db');
	const { JobQueue } = await import('$lib/server/jobs/queue');
	const { AgentStore } = await import('$lib/server/ingress/agents');
	const db = openDb(dir);
	ref.rt = {
		jobs: new JobQueue(db),
		agents: new AgentStore(db),
		audit: { log: vi.fn(() => Promise.resolve()) },
		db
	} as unknown as Runtime;
	return { getRuntime: () => ref.rt };
});

const { POST: taskRoute } = await import('../../src/routes/admin/api/agents/[id]/task/+server');

const admin = { id: 1, username: 'root', role: 'admin' } as PublicUser;

function event(
	id: string,
	body: unknown,
	perms: Set<string> | null = new Set(['agents.manage'])
): RequestEvent {
	return {
		params: { id },
		locals: perms === null ? {} : { user: admin, perms },
		url: new URL('http://test/admin/api/agents/x/task'),
		request: new Request('http://test/admin/api/agents/x/task', {
			method: 'POST',
			body: JSON.stringify(body)
		}),
		getClientAddress: () => '127.0.0.1'
	} as unknown as RequestEvent;
}

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

async function makeAgent(name: string): Promise<string> {
	return (await ref.rt.agents.create(name, null)).id;
}

describe('agent task route', () => {
	it('requires agents.manage', async () => {
		const id = await makeAgent('web1');
		await expect(
			taskRoute(event(id, { action: 'host.reboot' }, new Set()) as never)
		).rejects.toMatchObject({ status: 403 });
		await expect(
			taskRoute(event(id, { action: 'host.reboot' }, null) as never)
		).rejects.toMatchObject({ status: 401 });
	});

	it('404s on a missing agent', async () => {
		const res = await taskRoute(event('ag_missing', { action: 'packages.refresh' }) as never);
		expect(res.status).toBe(404);
	});

	it('enqueues a service task with a validated unit', async () => {
		const id = await makeAgent('web2');
		const res = await taskRoute(event(id, { action: 'service.restart', unit: 'nginx' }) as never);
		const body = await json(res);
		expect(body.ok).toBe(true);
		const job = (await ref.rt.jobs.list({ kind: 'agent-task' }))[0];
		expect(job.target).toBe(id);
		expect(JSON.parse(job.spec)).toEqual({ action: 'service.restart', unit: 'nginx' });
	});

	it('rejects unknown actions and dirty units', async () => {
		const id = await makeAgent('web3');
		for (const body of [
			{ action: 'host.poweroff' },
			{ action: '' },
			{ action: 'service.start' },
			{ action: 'service.start', unit: 'nginx; rm -rf /' },
			{ action: 'service.start', unit: '../../x' },
			{ action: 'packages.apply', unit: 'oops' }
		]) {
			const res = await taskRoute(event(id, body) as never);
			expect(res.status, JSON.stringify(body)).toBe(422);
		}
	});

	it('schedules with not_before inside the bound and rejects far-out times', async () => {
		const id = await makeAgent('web4');
		const at = Date.now() + 3600_000;
		const res = await taskRoute(
			event(id, { action: 'packages.apply', securityOnly: true, at }) as never
		);
		expect(res.status).toBe(200);
		const jobs = await ref.rt.jobs.list({ kind: 'agent-task' });
		const scheduled = jobs.find((j) => j.notBefore === at);
		expect(scheduled).toBeTruthy();
		expect(JSON.parse(scheduled!.spec)).toEqual({
			action: 'packages.apply',
			securityOnly: true
		});

		for (const bad of [
			{ at: Date.now() - 1000 },
			{ at: Date.now() + 8 * 24 * 3600_000 },
			{ at: 'tomorrow' }
		]) {
			const r = await taskRoute(event(id, { action: 'packages.refresh', ...bad }) as never);
			expect(r.status, JSON.stringify(bad)).toBe(422);
		}
	});

	it('mutes the offline alert for a reboot drain window', async () => {
		const id = await makeAgent('web5');
		const res = await taskRoute(event(id, { action: 'host.reboot' }) as never);
		expect(res.status).toBe(200);
		const agent = (await ref.rt.agents.get(id))!;
		expect(agent.mutedUntil).toBeGreaterThan(Date.now());
		expect(agent.mutedUntil).toBeLessThanOrEqual(Date.now() + 31 * 60_000);
	});

	it('rejects tasks on revoked agents', async () => {
		const id = await makeAgent('web6');
		await ref.rt.agents.revoke(id);
		const res = await taskRoute(event(id, { action: 'packages.refresh' }) as never);
		expect(res.status).toBe(409);
	});
});
