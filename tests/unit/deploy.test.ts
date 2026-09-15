import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '$lib/server/store/db';
import { JobQueue } from '$lib/server/jobs/queue';
import { DeployError, DeployStore, opensshPub } from '$lib/server/deploy/store';
import { settleDeployJob, triggerDeploy } from '$lib/server/deploy/trigger';
import type { Runtime } from '$lib/server/runtime';
import type { DeploySpec } from '$lib/shared/deploy';

process.env.WHARFINGER_SECRET_KEY = 'unit-test-secret-key-material';

function stores() {
	const db = openDb(mkdtempSync(join(tmpdir(), 'wharfinger-deploy-')));
	const jobs = new JobQueue(db);
	const deploys = new DeployStore(db);
	const rt = { db, jobs, deploys } as unknown as Runtime;
	return { db, jobs, deploys, rt };
}

const GIT = { kind: 'git' as const, url: 'git@github.com:org/repo.git', ref: 'main' };

async function expectDeployError(fn: () => Promise<unknown>, status: number): Promise<void> {
	try {
		await fn();
	} catch (err) {
		expect(err).toBeInstanceOf(DeployError);
		expect((err as DeployError).status).toBe(status);
		return;
	}
	expect.unreachable('expected DeployError');
}

describe('DeployStore apps', () => {
	it('creates an app with webhook and deploy key, both shown once', async () => {
		const { deploys } = stores();
		const { app, webhook, deployKeyPub } = await deploys.createApp({
			name: 'site',
			agentId: 'agent-1',
			source: GIT,
			domains: ['Example.COM', 'example.com']
		});
		expect(app.name).toBe('site');
		expect(app.webhook).toBe('');
		expect(webhook).toBeTruthy();
		expect(deployKeyPub).toMatch(/^ssh-ed25519 AAAA/);
		expect(app.hasDeployKey).toBe(true);
		expect(app.domains).toEqual(['example.com']);
		expect((await deploys.byWebhook(webhook))!.id).toBe(app.id);
		expect(await deploys.byWebhook('wrong')).toBeNull();
	});

	it('rejects invalid names, urls, and domains', async () => {
		const { deploys } = stores();
		await expectDeployError(
			() => deploys.createApp({ name: 'Bad Name', agentId: 'a', source: GIT }),
			422
		);
		await expectDeployError(
			() =>
				deploys.createApp({
					name: 'x',
					agentId: 'a',
					source: { kind: 'git', url: 'file:///etc/passwd' }
				}),
			422
		);
		await expectDeployError(
			() =>
				deploys.createApp({
					name: 'x',
					agentId: 'a',
					source: GIT,
					domains: ['not a domain..']
				}),
			422
		);
	});

	it('rejects duplicate names atomically', async () => {
		const { deploys } = stores();
		await deploys.createApp({ name: 'dup', agentId: 'a', source: GIT });
		await expectDeployError(
			() => deploys.createApp({ name: 'dup', agentId: 'a', source: GIT }),
			409
		);
	});

	it('env roundtrips through the seal and validates keys', async () => {
		const { db, deploys } = stores();
		const { app } = await deploys.createApp({ name: 'envy', agentId: 'a', source: GIT });
		await deploys.setEnv(app.id, { API_KEY: 's3cret', PLAIN: 'v' });
		expect(await deploys.envFor(app.id)).toEqual({ API_KEY: 's3cret', PLAIN: 'v' });
		await expectDeployError(() => deploys.setEnv(app.id, { 'BAD KEY': 'x' }), 422);
		// The stored value is sealed, not the plaintext map.
		const raw = db.prepare('SELECT env FROM deploy_apps WHERE id = ?').get(app.id) as {
			env: string;
		};
		expect(raw.env).toMatch(/^v1\./);
		expect(raw.env).not.toContain('s3cret');
	});

	it('webhook rotation invalidates the old token', async () => {
		const { deploys } = stores();
		const { app, webhook } = await deploys.createApp({ name: 'rot', agentId: 'a', source: GIT });
		const next = await deploys.rotateWebhook(app.id);
		expect(next).not.toBe(webhook);
		expect(await deploys.byWebhook(webhook)).toBeNull();
		expect((await deploys.byWebhook(next))!.id).toBe(app.id);
	});

	it('updateApp rejects a stale updatedAt and accepts a fresh one', async () => {
		const { deploys } = stores();
		const { app } = await deploys.createApp({
			name: 'stale',
			agentId: 'a',
			source: GIT,
			domains: ['a.example.com']
		});
		// First writer wins and moves the stamp.
		await deploys.updateApp(app.id, {
			domains: ['b.example.com'],
			expectedUpdatedAt: app.updatedAt
		});
		// A second writer still holding the old stamp loses.
		await expectDeployError(
			() =>
				deploys.updateApp(app.id, {
					domains: ['c.example.com'],
					expectedUpdatedAt: app.updatedAt
				}),
			409
		);
		const after = (await deploys.getApp(app.id))!;
		expect(after.domains).toEqual(['b.example.com']);
		// Fresh stamp applies cleanly.
		await deploys.updateApp(app.id, {
			domains: ['c.example.com'],
			expectedUpdatedAt: after.updatedAt
		});
		expect((await deploys.getApp(app.id))!.domains).toEqual(['c.example.com']);
	});

	it('setEnv rejects a stale updatedAt', async () => {
		const { deploys } = stores();
		const { app } = await deploys.createApp({ name: 'envstale', agentId: 'a', source: GIT });
		await deploys.setEnv(app.id, { A: '1' }, app.updatedAt);
		await expectDeployError(() => deploys.setEnv(app.id, { B: '2' }, app.updatedAt), 409);
		expect(await deploys.envFor(app.id)).toEqual({ A: '1' });
	});

	it('deploy key rotates to a different sealed pair', async () => {
		const { deploys } = stores();
		const { app, deployKeyPub } = await deploys.createApp({
			name: 'keyed',
			agentId: 'a',
			source: GIT
		});
		const before = (await deploys.deployKeyFor(app.id))!;
		const pub2 = await deploys.rotateDeployKey(app.id);
		const after = (await deploys.deployKeyFor(app.id))!;
		expect(pub2).not.toBe(deployKeyPub);
		expect(after.priv.equals(before.priv)).toBe(false);
	});
});

describe('triggerDeploy', () => {
	it('enqueues a frozen spec and a pending release', async () => {
		const { deploys, rt } = stores();
		const { app } = await deploys.createApp({
			name: 'web',
			agentId: 'agent-9',
			source: GIT,
			healthcheck: { kind: 'http', port: 3000 }
		});
		const { job, releaseId, deduped } = await triggerDeploy(rt, app);
		expect(deduped).toBe(false);
		expect(job.target).toBe('agent-9');
		expect(job.maxAttempts).toBe(1);
		const spec = JSON.parse(job.spec) as DeploySpec;
		expect(spec.appId).toBe(app.id);
		expect(spec.releaseId).toBe(releaseId);
		expect(spec.run.healthcheck?.port).toBe(3000);
		expect('env' in spec).toBe(false); // secrets never ride the spec
		expect((await deploys.release(releaseId!))!.status).toBe('pending');
	});

	it('emits a static spec with no ports or healthcheck', async () => {
		const { deploys, rt } = stores();
		const { app } = await deploys.createApp({
			name: 'stat',
			agentId: 'a',
			source: { kind: 'static', url: GIT.url, ref: 'main', subdir: 'dist' },
			domains: ['stat.example.com'],
			ports: [{ host: 8080, container: 80 }],
			healthcheck: { kind: 'http', port: 8080 }
		});
		const { job } = await triggerDeploy(rt, app);
		const spec = JSON.parse(job.spec) as DeploySpec;
		expect(spec.source.kind).toBe('static');
		expect(spec.build).toEqual({ kind: 'static', context: 'dist' });
		expect(spec.run.ports).toEqual([]);
		expect(spec.run.healthcheck).toBeUndefined();
		// envRef stays: the agent fetches the deploy key through it.
		expect(spec.run.envRef).toBe(app.id);
	});

	it('dedupes repeat triggers on jobKey without a new release', async () => {
		const { deploys, rt } = stores();
		const { app } = await deploys.createApp({ name: 'dd', agentId: 'a', source: GIT });
		const first = await triggerDeploy(rt, app, { jobKey: 'deploy:dd:hook:1' });
		const second = await triggerDeploy(rt, app, { jobKey: 'deploy:dd:hook:1' });
		expect(second.deduped).toBe(true);
		expect(second.releaseId).toBeNull();
		expect(second.job.id).toBe(first.job.id);
		expect(await deploys.releases(app.id)).toHaveLength(1);
	});

	it('rollback reuses the target release frozen spec', async () => {
		const { deploys, rt } = stores();
		const { app } = await deploys.createApp({ name: 'rb', agentId: 'a', source: GIT });
		const first = await triggerDeploy(rt, app);
		const rb = await triggerDeploy(rt, app, { rollbackTo: first.releaseId! });
		const spec = JSON.parse(rb.job.spec) as DeploySpec;
		expect(spec.rollbackOf).toBe(first.releaseId);
		expect(spec.releaseId).toBe(rb.releaseId);
		await expectDeployError(() => triggerDeploy(rt, app, { rollbackTo: 'rel_nope' }), 404);
	});

	it('settles release status from job results', async () => {
		const { deploys, rt, jobs } = stores();
		const { app } = await deploys.createApp({ name: 'stl', agentId: 'a', source: GIT });
		const { job, releaseId } = await triggerDeploy(rt, app);
		const c = (await jobs.claim('deploy', 'a'))!;
		await jobs.succeed(c.id, c.lease, { commit: 'abc', image: 'web:rel_1' });
		await settleDeployJob(rt, job.id);
		expect((await deploys.release(releaseId!))!.status).toBe('live');

		const second = await triggerDeploy(rt, app);
		const c2 = (await jobs.claim('deploy', 'a'))!;
		await jobs.fail(c2.id, c2.lease, { err: 'boom' });
		await settleDeployJob(rt, second.job.id);
		expect((await deploys.release(second.releaseId!))!.status).toBe('failed');
		expect((await deploys.liveRelease(app.id))!.id).toBe(releaseId);
	});

	it('markLive supersedes the previous live release atomically', async () => {
		const { deploys, rt, jobs } = stores();
		const { app } = await deploys.createApp({ name: 'sup', agentId: 'a', source: GIT });
		const r1 = await triggerDeploy(rt, app);
		const c1 = (await jobs.claim('deploy', 'a'))!;
		await jobs.succeed(c1.id, c1.lease, {});
		await settleDeployJob(rt, r1.job.id);

		const r2 = await triggerDeploy(rt, app);
		const c2 = (await jobs.claim('deploy', 'a'))!;
		await jobs.succeed(c2.id, c2.lease, {});
		await settleDeployJob(rt, r2.job.id);

		expect((await deploys.release(r1.releaseId!))!.status).toBe('superseded');
		expect((await deploys.release(r2.releaseId!))!.status).toBe('live');
		expect((await deploys.liveRelease(app.id))!.id).toBe(r2.releaseId);
	});

	it('validates k8s namespace and replicas', async () => {
		const { deploys } = stores();
		// k8s fields rejected on container runtimes.
		await expectDeployError(
			() => deploys.createApp({ name: 'a', agentId: 'x', source: GIT, namespace: 'prod' }),
			422
		);
		await expectDeployError(
			() => deploys.createApp({ name: 'a', agentId: 'x', source: GIT, replicas: 3 }),
			422
		);
		// Bad namespace shapes and replica bounds.
		await expectDeployError(
			() =>
				deploys.createApp({
					name: 'a',
					agentId: 'x',
					source: GIT,
					runtime: 'k8s',
					namespace: 'Bad_NS'
				}),
			422
		);
		await expectDeployError(
			() =>
				deploys.createApp({
					name: 'a',
					agentId: 'x',
					source: GIT,
					runtime: 'k8s',
					replicas: 0
				}),
			422
		);
		await expectDeployError(
			() =>
				deploys.createApp({
					name: 'a',
					agentId: 'x',
					source: GIT,
					runtime: 'k8s',
					replicas: 11
				}),
			422
		);
		const { app } = await deploys.createApp({
			name: 'k-app',
			agentId: 'x',
			source: GIT,
			runtime: 'k8s',
			namespace: 'prod-web',
			replicas: 3
		});
		expect(app.namespace).toBe('prod-web');
		expect(app.replicas).toBe(3);
		// Empty namespace string normalizes to null.
		const { app: app2 } = await deploys.createApp({
			name: 'k-app2',
			agentId: 'x',
			source: GIT,
			runtime: 'k8s',
			namespace: '  '
		});
		expect(app2.namespace).toBeNull();
	});

	it('clears k8s fields when switching runtimes', async () => {
		const { deploys } = stores();
		const { app } = await deploys.createApp({
			name: 'k-app',
			agentId: 'x',
			source: GIT,
			runtime: 'k8s',
			namespace: 'prod',
			replicas: 2
		});
		const updated = await deploys.updateApp(app.id, { runtime: 'docker' });
		expect(updated.namespace).toBeNull();
		expect(updated.replicas).toBeNull();
	});

	it('validates port mappings and auto-derives a localhost publish for domain apps', async () => {
		const { deploys, rt } = stores();
		await expectDeployError(
			() =>
				deploys.createApp({
					name: 'a',
					agentId: 'x',
					source: GIT,
					ports: [{ host: 0, container: 80 }]
				}),
			422
		);
		await expectDeployError(
			() =>
				deploys.createApp({
					name: 'a',
					agentId: 'x',
					source: GIT,
					ports: [
						{ host: 8080, container: 80 },
						{ host: 8080, container: 81 }
					]
				}),
			422
		);
		// Domains + healthcheck port, no explicit ports: the spec
		// publishes the healthcheck port bound to localhost so the
		// edge proxy has an upstream without public exposure.
		const { app } = await deploys.createApp({
			name: 'edgeapp',
			agentId: 'x',
			source: GIT,
			domains: ['edge.example.com'],
			healthcheck: { kind: 'http', port: 8080 }
		});
		const t = await triggerDeploy(rt, app);
		const spec = JSON.parse(
			(await rt.jobs.byKey(`deploy:${app.id}:${t.releaseId}`))!.spec
		) as DeploySpec;
		expect(spec.run.ports).toEqual([{ host: 8080, container: 8080, local: true }]);
		// Explicit ports win over the derivation and keep their flags.
		const { app: app2 } = await deploys.createApp({
			name: 'edgeapp2',
			agentId: 'x',
			source: GIT,
			domains: ['e2.example.com'],
			healthcheck: { kind: 'http', port: 8080 },
			ports: [{ host: 9090, container: 80, local: true }]
		});
		const t2 = await triggerDeploy(rt, app2);
		const spec2 = JSON.parse(
			(await rt.jobs.byKey(`deploy:${app2.id}:${t2.releaseId}`))!.spec
		) as DeploySpec;
		expect(spec2.run.ports).toEqual([{ host: 9090, container: 80, local: true }]);
		// No domains and no ports: nothing is published.
		const { app: app3 } = await deploys.createApp({
			name: 'nopub',
			agentId: 'x',
			source: GIT,
			healthcheck: { kind: 'http', port: 8080 }
		});
		const t3 = await triggerDeploy(rt, app3);
		const spec3 = JSON.parse(
			(await rt.jobs.byKey(`deploy:${app3.id}:${t3.releaseId}`))!.spec
		) as DeploySpec;
		expect(spec3.run.ports).toEqual([]);
	});

	it('bakes namespace and replicas into the deploy spec', async () => {
		const { deploys, rt } = stores();
		const { app } = await deploys.createApp({
			name: 'k-spec',
			agentId: 'x',
			source: GIT,
			runtime: 'k8s',
			namespace: 'prod',
			replicas: 2
		});
		const t = await triggerDeploy(rt, app);
		const job = (await rt.jobs.byKey(`deploy:${app.id}:${t.releaseId}`))!;
		const spec = JSON.parse(job.spec) as DeploySpec;
		expect(spec.runtime).toBe('k8s');
		expect(spec.namespace).toBe('prod');
		expect(spec.run.replicas).toBe(2);
	});

	it('opensshPub emits a valid wire blob', () => {
		const raw = Buffer.alloc(32, 7);
		const line = opensshPub(raw, 'test');
		expect(line.startsWith('ssh-ed25519 ')).toBe(true);
		const blob = Buffer.from(line.split(' ')[1], 'base64');
		// string 'ssh-ed25519' (len 11) then 32-byte key
		expect(blob.readUInt32BE(0)).toBe(11);
		expect(blob.length).toBe(4 + 11 + 4 + 32);
	});
});
