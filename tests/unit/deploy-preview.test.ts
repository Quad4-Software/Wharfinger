import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '$lib/server/store/db';
import { JobQueue } from '$lib/server/jobs/queue';
import { DeployError, DeployStore } from '$lib/server/deploy/store';
import { settleDeployJob } from '$lib/server/deploy/trigger';
import {
	MAX_PREVIEWS,
	PREVIEW_TTL_MS,
	closeAllPreviews,
	closePreview,
	openPreview,
	previewDomain,
	previewName,
	sweepPreviews
} from '$lib/server/deploy/preview';
import type { Runtime } from '$lib/server/runtime';
import type { DeployApp, TeardownSpec } from '$lib/shared/deploy';

process.env.WHARFINGER_SECRET_KEY = 'unit-test-secret-key-material';

function stores() {
	const db = openDb(mkdtempSync(join(tmpdir(), 'wharfinger-preview-')));
	const jobs = new JobQueue(db);
	const deploys = new DeployStore(db);
	// The status post path needs an egress handle; the fake blocks
	// link-local and never sends, which is enough for these tests.
	const egress = { dispatcher: undefined, allowLinkLocal: () => false };
	const rt = { db, jobs, deploys, egress } as unknown as Runtime;
	return { db, jobs, deploys, rt };
}

const GIT = {
	kind: 'git' as const,
	url: 'git@github.com:org/repo.git',
	ref: 'main',
	previews: true
};

async function parent(
	deploys: DeployStore,
	over: Record<string, unknown> = {}
): Promise<DeployApp> {
	const { app } = await deploys.createApp({
		name: 'myapp',
		agentId: 'agent-1',
		source: GIT,
		domains: ['myapp.example.com'],
		healthcheck: { kind: 'http', port: 3000 },
		ports: [{ host: 8080, container: 3000 }],
		...over
	});
	return app;
}

const PR = { action: 'update' as const, pr: 42, sha: 'deadbeef42' };

describe('preview naming and domains', () => {
	it('derives <parent>-pr<N> names and stays in the label limit', () => {
		const app = { name: 'myapp' } as DeployApp;
		expect(previewName(app, 42)).toBe('myapp-pr42');
		const long = { name: 'a'.repeat(63) } as DeployApp;
		const name = previewName(long, 12345);
		expect(name.length).toBeLessThanOrEqual(63);
		expect(name).toMatch(/^a+-pr12345$/);
	});

	it('derives the preview domain by replacing the first label', () => {
		const app = { domains: ['myapp.example.com'] } as DeployApp;
		expect(previewDomain(app, 'myapp-pr42')).toBe('myapp-pr42.example.com');
		// Wildcards are skipped for derivation; a bare domain yields none.
		const wild = { domains: ['*.example.com', 'app.internal.lan'] } as DeployApp;
		expect(previewDomain(wild, 'x-pr1')).toBe('x-pr1.internal.lan');
		expect(previewDomain({ domains: ['example.com'] } as unknown as DeployApp, 'x-pr1')).toBeNull();
		expect(previewDomain({ domains: [] } as unknown as DeployApp, 'x-pr1')).toBeNull();
	});
});

describe('openPreview', () => {
	it('copies sealed env, forge token, and deploy key verbatim', async () => {
		const { deploys } = stores();
		const p = await parent(deploys);
		await deploys.setEnv(p.id, { API_KEY: 's3cret' });
		await deploys.setForgeToken(p.id, 'ghp_tok');
		const app = await deploys.createPreviewApp(p, {
			name: 'myapp-pr42',
			pr: 42,
			source: { ...p.source, ref: 'refs/pull/42/head' },
			domains: ['myapp-pr42.example.com'],
			ports: [{ host: 31000, container: 3000, local: true }],
			expiresAt: Date.now() + PREVIEW_TTL_MS
		});
		expect(await deploys.envFor(app.id)).toEqual({ API_KEY: 's3cret' });
		expect(await deploys.forgeToken(app.id)).toBe('ghp_tok');
		expect(app.hasForgeToken).toBe(true);
		expect(app.hasDeployKey).toBe(true);
		expect(app.previewOf).toBe(p.id);
		expect(app.previewPr).toBe(42);
	});

	it('creates a preview app with PR head ref and a deploy job', async () => {
		const { deploys, rt, jobs } = stores();
		const p = await parent(deploys);
		await deploys.setEnv(p.id, { API_KEY: 's3cret' });

		const out = await openPreview(rt, p, PR, 'del-1');
		expect(out.deduped).toBe(false);
		const app = out.app;
		expect(app.name).toBe('myapp-pr42');
		expect(app.previewOf).toBe(p.id);
		expect(app.previewPr).toBe(42);
		expect(app.previewExpires).toBeGreaterThan(Date.now() + PREVIEW_TTL_MS - 60_000);
		expect(app.domains).toEqual(['myapp-pr42.example.com']);
		expect(app.source.ref).toBe('refs/pull/42/head');
		// Ports: parent's host port is replaced by an allocated local one.
		expect(app.ports).toHaveLength(1);
		expect(app.ports[0].container).toBe(3000);
		expect(app.ports[0].local).toBe(true);
		expect(app.ports[0].host).toBeGreaterThanOrEqual(30000);
		expect(app.ports[0].host).not.toBe(8080);
		expect(await deploys.envFor(app.id)).toEqual({ API_KEY: 's3cret' });

		const job = await jobs.get(out.jobId);
		expect(job?.kind).toBe('deploy');
		expect(job?.target).toBe('agent-1');
		expect((await deploys.release(out.releaseId!))!.commit).toBe('deadbeef42');
	});

	it('reuses the preview app on synchronize and refreshes the TTL', async () => {
		const { deploys, rt } = stores();
		const p = await parent(deploys);
		const first = await openPreview(rt, p, PR, 'del-1');
		const second = await openPreview(rt, p, { ...PR, sha: 'newsha' }, 'del-2');
		expect(second.app.id).toBe(first.app.id);
		expect(second.deduped).toBe(false);
		expect((await deploys.previewFor(p.id, 42))!.id).toBe(first.app.id);
		// The stored ref is the stable PR ref; the new head resolves at fetch.
		expect(second.app.source.ref).toBe('refs/pull/42/head');
	});

	it('dedupes a repeated delivery', async () => {
		const { deploys, rt } = stores();
		const p = await parent(deploys);
		const first = await openPreview(rt, p, PR, 'del-1');
		const second = await openPreview(rt, p, PR, 'del-1');
		expect(second.deduped).toBe(true);
		expect(second.releaseId).toBeNull();
		expect(second.jobId).toBe(first.jobId);
	});

	it('caps previews per parent app', async () => {
		const { deploys, rt } = stores();
		const p = await parent(deploys);
		for (let pr = 1; pr <= MAX_PREVIEWS; pr++) {
			await openPreview(rt, p, { action: 'update', pr, sha: null }, `d-${pr}`);
		}
		try {
			await openPreview(rt, p, { action: 'update', pr: 99, sha: null }, 'd-99');
			expect.unreachable('expected cap error');
		} catch (err) {
			expect(err).toBeInstanceOf(DeployError);
			expect((err as DeployError).status).toBe(429);
		}
	});

	it('rejects non-git parents', async () => {
		const { deploys, rt } = stores();
		const p = await parent(deploys, { source: { kind: 'image', url: 'nginx:latest' } });
		await expect(openPreview(rt, p, PR, 'd-1')).rejects.toBeInstanceOf(DeployError);
	});

	it('requires the previews opt-in on the source', async () => {
		const { deploys, rt, jobs } = stores();
		const p = await parent(deploys, {
			source: { kind: 'git', url: 'git@github.com:org/repo.git', ref: 'main' }
		});
		try {
			await openPreview(rt, p, PR, 'd-1');
			expect.unreachable('expected opt-in rejection');
		} catch (err) {
			expect(err).toBeInstanceOf(DeployError);
			expect((err as DeployError).status).toBe(422);
		}
		expect(await deploys.previewFor(p.id, 42)).toBeNull();
		expect(await jobs.claim('deploy', 'agent-1')).toBeNull();
	});

	it('a preview app cannot spawn its own previews', async () => {
		const { deploys, rt } = stores();
		const p = await parent(deploys);
		const { app } = await openPreview(rt, p, PR, 'd-1');
		expect(app.source.previews).not.toBe(true);
		await expect(
			openPreview(rt, app, { action: 'update', pr: 7, sha: null }, 'd-2')
		).rejects.toBeInstanceOf(DeployError);
	});

	it('allocates distinct ports across previews on one agent', async () => {
		const { deploys, rt } = stores();
		const p = await parent(deploys);
		const a = await openPreview(rt, p, { action: 'update', pr: 1, sha: null }, 'd1');
		const b = await openPreview(rt, p, { action: 'update', pr: 2, sha: null }, 'd2');
		expect(a.app.ports[0].host).not.toBe(b.app.ports[0].host);
	});
});

describe('closePreview and sweep', () => {
	it('enqueues a teardown job and removes the app', async () => {
		const { deploys, rt, jobs } = stores();
		const p = await parent(deploys);
		const { app } = await openPreview(rt, p, PR, 'd-1');
		const { closed } = await closePreview(rt, p, 42);
		expect(closed).toBe(true);
		expect(await deploys.getApp(app.id)).toBeNull();
		const job = (await jobs.claim('teardown', 'agent-1'))!;
		expect(job).toBeTruthy();
		const spec = JSON.parse(job.spec) as TeardownSpec;
		expect(spec.appId).toBe(app.id);
		expect(spec.runtime).toBe('podman');
	});

	it('is a no-op when the preview does not exist', async () => {
		const { deploys, rt, jobs } = stores();
		const p = await parent(deploys);
		expect((await closePreview(rt, p, 77)).closed).toBe(false);
		expect(await jobs.claim('teardown', 'agent-1')).toBeNull();
	});

	it('sweep tears down only expired previews', async () => {
		const { deploys, rt, jobs, db } = stores();
		const p = await parent(deploys);
		const fresh = await openPreview(rt, p, { action: 'update', pr: 1, sha: null }, 'd1');
		const stale = await openPreview(rt, p, { action: 'update', pr: 2, sha: null }, 'd2');
		// Age out the second preview only.
		db.prepare('UPDATE deploy_apps SET preview_expires = ? WHERE id = ?').run(
			Date.now() - 1000,
			stale.app.id
		);
		expect(await sweepPreviews(rt)).toBe(1);
		expect(await deploys.getApp(stale.app.id)).toBeNull();
		expect(await deploys.getApp(fresh.app.id)).not.toBeNull();
		const job = (await jobs.claim('teardown', 'agent-1'))!;
		expect((JSON.parse(job.spec) as TeardownSpec).appId).toBe(stale.app.id);
	});

	it('a terminal teardown job settles without touching deploy state', async () => {
		const { deploys, rt, jobs } = stores();
		const p = await parent(deploys);
		const { app } = await openPreview(rt, p, PR, 'd-1');
		await closePreview(rt, p, 42);
		const job = (await jobs.claim('teardown', 'agent-1'))!;
		await jobs.start(job.id, job.lease);
		await jobs.succeed(job.id, job.lease, { ok: true });
		// The generic lifecycle route calls settleDeployJob for every
		// terminal job; teardown kinds must pass through untouched.
		await expect(settleDeployJob(rt, job.id)).resolves.toBeUndefined();
		expect(await deploys.getApp(app.id)).toBeNull();
	});

	it('closeAllPreviews tears down every preview of a deleted parent', async () => {
		const { deploys, rt, jobs } = stores();
		const p = await parent(deploys);
		const a = await openPreview(rt, p, { action: 'update', pr: 1, sha: null }, 'd1');
		const b = await openPreview(rt, p, { action: 'update', pr: 2, sha: null }, 'd2');
		expect(await closeAllPreviews(rt, p.id)).toBe(2);
		expect(await deploys.getApp(a.app.id)).toBeNull();
		expect(await deploys.getApp(b.app.id)).toBeNull();
		const t1 = (await jobs.claim('teardown', 'agent-1'))!;
		const t2 = (await jobs.claim('teardown', 'agent-1'))!;
		expect(new Set([t1, t2].map((j) => (JSON.parse(j.spec) as TeardownSpec).appId))).toEqual(
			new Set([a.app.id, b.app.id])
		);
	});
});
