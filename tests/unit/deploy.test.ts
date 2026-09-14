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

function expectDeployError(fn: () => unknown, status: number): void {
	try {
		fn();
	} catch (err) {
		expect(err).toBeInstanceOf(DeployError);
		expect((err as DeployError).status).toBe(status);
		return;
	}
	expect.unreachable('expected DeployError');
}

describe('DeployStore apps', () => {
	it('creates an app with webhook and deploy key, both shown once', () => {
		const { deploys } = stores();
		const { app, webhook, deployKeyPub } = deploys.createApp({
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
		expect(deploys.byWebhook(webhook)!.id).toBe(app.id);
		expect(deploys.byWebhook('wrong')).toBeNull();
	});

	it('rejects invalid names, urls, and domains', () => {
		const { deploys } = stores();
		expectDeployError(
			() => deploys.createApp({ name: 'Bad Name', agentId: 'a', source: GIT }),
			422
		);
		expectDeployError(
			() =>
				deploys.createApp({
					name: 'x',
					agentId: 'a',
					source: { kind: 'git', url: 'file:///etc/passwd' }
				}),
			422
		);
		expectDeployError(
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

	it('rejects duplicate names atomically', () => {
		const { deploys } = stores();
		deploys.createApp({ name: 'dup', agentId: 'a', source: GIT });
		expectDeployError(() => deploys.createApp({ name: 'dup', agentId: 'a', source: GIT }), 409);
	});

	it('env roundtrips through the seal and validates keys', () => {
		const { deploys } = stores();
		const { app } = deploys.createApp({ name: 'envy', agentId: 'a', source: GIT });
		deploys.setEnv(app.id, { API_KEY: 's3cret', PLAIN: 'v' });
		expect(deploys.envFor(app.id)).toEqual({ API_KEY: 's3cret', PLAIN: 'v' });
		expectDeployError(() => {
			deploys.setEnv(app.id, { 'BAD KEY': 'x' });
		}, 422);
		// The stored value is sealed, not the plaintext map.
		const raw = (deploys as unknown as { db: import('node:sqlite').DatabaseSync }).db
			.prepare('SELECT env FROM deploy_apps WHERE id = ?')
			.get(app.id) as { env: string };
		expect(raw.env).toMatch(/^v1\./);
		expect(raw.env).not.toContain('s3cret');
	});

	it('webhook rotation invalidates the old token', () => {
		const { deploys } = stores();
		const { app, webhook } = deploys.createApp({ name: 'rot', agentId: 'a', source: GIT });
		const next = deploys.rotateWebhook(app.id);
		expect(next).not.toBe(webhook);
		expect(deploys.byWebhook(webhook)).toBeNull();
		expect(deploys.byWebhook(next)!.id).toBe(app.id);
	});

	it('deploy key rotates to a different sealed pair', () => {
		const { deploys } = stores();
		const { app, deployKeyPub } = deploys.createApp({ name: 'keyed', agentId: 'a', source: GIT });
		const before = deploys.deployKeyFor(app.id)!;
		const pub2 = deploys.rotateDeployKey(app.id);
		const after = deploys.deployKeyFor(app.id)!;
		expect(pub2).not.toBe(deployKeyPub);
		expect(after.priv.equals(before.priv)).toBe(false);
	});
});

describe('triggerDeploy', () => {
	it('enqueues a frozen spec and a pending release', () => {
		const { deploys, rt } = stores();
		const { app } = deploys.createApp({
			name: 'web',
			agentId: 'agent-9',
			source: GIT,
			healthcheck: { kind: 'http', port: 3000 }
		});
		const { job, releaseId, deduped } = triggerDeploy(rt, app);
		expect(deduped).toBe(false);
		expect(job.target).toBe('agent-9');
		expect(job.maxAttempts).toBe(1);
		const spec = JSON.parse(job.spec) as DeploySpec;
		expect(spec.appId).toBe(app.id);
		expect(spec.releaseId).toBe(releaseId);
		expect(spec.run.healthcheck?.port).toBe(3000);
		expect('env' in spec).toBe(false); // secrets never ride the spec
		expect(deploys.release(releaseId!)!.status).toBe('pending');
	});

	it('dedupes repeat triggers on jobKey without a new release', () => {
		const { deploys, rt } = stores();
		const { app } = deploys.createApp({ name: 'dd', agentId: 'a', source: GIT });
		const first = triggerDeploy(rt, app, { jobKey: 'deploy:dd:hook:1' });
		const second = triggerDeploy(rt, app, { jobKey: 'deploy:dd:hook:1' });
		expect(second.deduped).toBe(true);
		expect(second.releaseId).toBeNull();
		expect(second.job.id).toBe(first.job.id);
		expect(deploys.releases(app.id)).toHaveLength(1);
	});

	it('rollback reuses the target release frozen spec', () => {
		const { deploys, rt } = stores();
		const { app } = deploys.createApp({ name: 'rb', agentId: 'a', source: GIT });
		const first = triggerDeploy(rt, app);
		const rb = triggerDeploy(rt, app, { rollbackTo: first.releaseId! });
		const spec = JSON.parse(rb.job.spec) as DeploySpec;
		expect(spec.rollbackOf).toBe(first.releaseId);
		expect(spec.releaseId).toBe(rb.releaseId);
		expectDeployError(() => triggerDeploy(rt, app, { rollbackTo: 'rel_nope' }), 404);
	});

	it('settles release status from job results', () => {
		const { deploys, rt, jobs } = stores();
		const { app } = deploys.createApp({ name: 'stl', agentId: 'a', source: GIT });
		const { job, releaseId } = triggerDeploy(rt, app);
		const c = jobs.claim('deploy', 'a')!;
		jobs.succeed(c.id, c.lease, { commit: 'abc', image: 'web:rel_1' });
		settleDeployJob(rt, job.id);
		expect(deploys.release(releaseId!)!.status).toBe('live');

		const second = triggerDeploy(rt, app);
		const c2 = jobs.claim('deploy', 'a')!;
		jobs.fail(c2.id, c2.lease, { err: 'boom' });
		settleDeployJob(rt, second.job.id);
		expect(deploys.release(second.releaseId!)!.status).toBe('failed');
		expect(deploys.liveRelease(app.id)!.id).toBe(releaseId);
	});

	it('markLive supersedes the previous live release atomically', () => {
		const { deploys, rt, jobs } = stores();
		const { app } = deploys.createApp({ name: 'sup', agentId: 'a', source: GIT });
		const r1 = triggerDeploy(rt, app);
		const c1 = jobs.claim('deploy', 'a')!;
		jobs.succeed(c1.id, c1.lease, {});
		settleDeployJob(rt, r1.job.id);

		const r2 = triggerDeploy(rt, app);
		const c2 = jobs.claim('deploy', 'a')!;
		jobs.succeed(c2.id, c2.lease, {});
		settleDeployJob(rt, r2.job.id);

		expect(deploys.release(r1.releaseId!)!.status).toBe('superseded');
		expect(deploys.release(r2.releaseId!)!.status).toBe('live');
		expect(deploys.liveRelease(app.id)!.id).toBe(r2.releaseId);
	});

	it('validates k8s namespace and replicas', () => {
		const { deploys } = stores();
		// k8s fields rejected on container runtimes.
		expectDeployError(
			() => deploys.createApp({ name: 'a', agentId: 'x', source: GIT, namespace: 'prod' }),
			422
		);
		expectDeployError(
			() => deploys.createApp({ name: 'a', agentId: 'x', source: GIT, replicas: 3 }),
			422
		);
		// Bad namespace shapes and replica bounds.
		expectDeployError(
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
		expectDeployError(
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
		expectDeployError(
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
		const { app } = deploys.createApp({
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
		const { app: app2 } = deploys.createApp({
			name: 'k-app2',
			agentId: 'x',
			source: GIT,
			runtime: 'k8s',
			namespace: '  '
		});
		expect(app2.namespace).toBeNull();
	});

	it('clears k8s fields when switching runtimes', () => {
		const { deploys } = stores();
		const { app } = deploys.createApp({
			name: 'k-app',
			agentId: 'x',
			source: GIT,
			runtime: 'k8s',
			namespace: 'prod',
			replicas: 2
		});
		const updated = deploys.updateApp(app.id, { runtime: 'docker' });
		expect(updated.namespace).toBeNull();
		expect(updated.replicas).toBeNull();
	});

	it('validates port mappings and auto-derives a localhost publish for domain apps', () => {
		const { deploys, rt } = stores();
		expectDeployError(
			() =>
				deploys.createApp({
					name: 'a',
					agentId: 'x',
					source: GIT,
					ports: [{ host: 0, container: 80 }]
				}),
			422
		);
		expectDeployError(
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
		const { app } = deploys.createApp({
			name: 'edgeapp',
			agentId: 'x',
			source: GIT,
			domains: ['edge.example.com'],
			healthcheck: { kind: 'http', port: 8080 }
		});
		const t = triggerDeploy(rt, app);
		const spec = JSON.parse(rt.jobs.byKey(`deploy:${app.id}:${t.releaseId}`)!.spec) as DeploySpec;
		expect(spec.run.ports).toEqual([{ host: 8080, container: 8080, local: true }]);
		// Explicit ports win over the derivation and keep their flags.
		const { app: app2 } = deploys.createApp({
			name: 'edgeapp2',
			agentId: 'x',
			source: GIT,
			domains: ['e2.example.com'],
			healthcheck: { kind: 'http', port: 8080 },
			ports: [{ host: 9090, container: 80, local: true }]
		});
		const t2 = triggerDeploy(rt, app2);
		const spec2 = JSON.parse(
			rt.jobs.byKey(`deploy:${app2.id}:${t2.releaseId}`)!.spec
		) as DeploySpec;
		expect(spec2.run.ports).toEqual([{ host: 9090, container: 80, local: true }]);
		// No domains and no ports: nothing is published.
		const { app: app3 } = deploys.createApp({
			name: 'nopub',
			agentId: 'x',
			source: GIT,
			healthcheck: { kind: 'http', port: 8080 }
		});
		const t3 = triggerDeploy(rt, app3);
		const spec3 = JSON.parse(
			rt.jobs.byKey(`deploy:${app3.id}:${t3.releaseId}`)!.spec
		) as DeploySpec;
		expect(spec3.run.ports).toEqual([]);
	});

	it('bakes namespace and replicas into the deploy spec', () => {
		const { deploys, rt } = stores();
		const { app } = deploys.createApp({
			name: 'k-spec',
			agentId: 'x',
			source: GIT,
			runtime: 'k8s',
			namespace: 'prod',
			replicas: 2
		});
		const t = triggerDeploy(rt, app);
		const job = rt.jobs.byKey(`deploy:${app.id}:${t.releaseId}`)!;
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
