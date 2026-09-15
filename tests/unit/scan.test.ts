import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '$lib/server/store/db';
import { JobQueue } from '$lib/server/jobs/queue';
import { DeployStore } from '$lib/server/deploy/store';
import { getScanStore } from '$lib/server/scan/store';
import { enqueueScan, markScanJobRunning, settleScanJob } from '$lib/server/scan/trigger';
import { evaluate, fixFor } from '$lib/server/scan/recommend';
import type { Runtime } from '$lib/server/runtime';
import type { AppSource, DeployApp, DeploySpec } from '$lib/shared/deploy';
import { MAX_FINDINGS_PER_REPORT } from '$lib/shared/scan';
import type { NewRecommendation, Recommendation, ScanFinding, ScanJobSpec } from '$lib/shared/scan';

process.env.WHARFINGER_SECRET_KEY = 'unit-test-secret-key-material';

function stores() {
	const db = openDb(mkdtempSync(join(tmpdir(), 'wharfinger-scan-')));
	const jobs = new JobQueue(db);
	const deploys = new DeployStore(db);
	const scans = getScanStore(db);
	const rt = { db, jobs, deploys } as unknown as Runtime;
	return { db, jobs, deploys, scans, rt };
}

const IMAGE = { kind: 'image' as const, url: 'registry.example.com/app:latest' };
const GIT = { kind: 'git' as const, url: 'git@github.com:org/repo.git', ref: 'main' };

async function mkApp(
	deploys: DeployStore,
	name = 'app',
	source: AppSource = IMAGE
): Promise<DeployApp> {
	return (await deploys.createApp({ name, agentId: 'agent-1', source })).app;
}

function finding(sev: ScanFinding['severity'], pkg = 'pkg', vuln = 'CVE-1'): ScanFinding {
	return { reportId: 'r', vulnId: vuln, pkg, severity: sev };
}

describe('ScanStore reports', () => {
	it('creates, lists, and completes a report with a summary rollup', async () => {
		const { scans } = stores();
		const rep = await scans.createReport({ appId: 'a1', target: 'img:1' });
		expect(rep.status).toBe('queued');
		expect((await scans.activeForApp('a1'))?.id).toBe(rep.id);

		await scans.markRunning(rep.id, rep.startedAt);
		expect((await scans.report(rep.id))?.status).toBe('running');

		const done = await scans.complete(rep.id, 'done', {
			finishedAt: rep.startedAt + 500,
			findings: [
				finding('critical', 'openssl', 'CVE-1'),
				finding('high', 'musl', 'CVE-2'),
				finding('medium', 'zlib', 'CVE-3'),
				finding('bogus' as ScanFinding['severity'], 'x', 'CVE-4'),
				// Duplicate (vuln, pkg) must collapse.
				finding('critical', 'openssl', 'CVE-1')
			]
		});
		expect(done?.status).toBe('done');
		expect(done?.durationMs).toBe(500);
		expect(done?.summary).toEqual({ critical: 1, high: 1, medium: 1, low: 0, unknown: 1 });
		expect(await scans.findings(rep.id)).toHaveLength(4);
		expect(await scans.activeForApp('a1')).toBeNull();
		expect((await scans.latestForApp('a1'))?.id).toBe(rep.id);
		expect(await scans.listForApp('a1')).toHaveLength(1);
	});

	it('caps findings at the per-report bound', async () => {
		const { scans } = stores();
		const rep = await scans.createReport({ appId: 'a1', target: 'img:1' });
		const many = Array.from({ length: MAX_FINDINGS_PER_REPORT + 100 }, (_, i) =>
			finding('low', `pkg${i}`, `CVE-${i}`)
		);
		await scans.complete(rep.id, 'done', { findings: many });
		expect(await scans.findings(rep.id)).toHaveLength(MAX_FINDINGS_PER_REPORT);
	});

	it('ignores a second completion for the same report', async () => {
		const { scans } = stores();
		const rep = await scans.createReport({ appId: 'a1', target: 'img:1' });
		await scans.complete(rep.id, 'done', { findings: [finding('critical')] });
		const again = await scans.complete(rep.id, 'failed', { error: 'late failure' });
		expect(again?.status).toBe('done');
		expect(again?.summary.critical).toBe(1);
	});

	it('returns latestPerApp one row per app', async () => {
		const { scans } = stores();
		await scans.createReport({ appId: 'a1', target: 'i1', now: 1000 });
		const newer = await scans.createReport({ appId: 'a1', target: 'i2', now: 2000 });
		await scans.createReport({ appId: 'a2', target: 'i3', now: 1500 });
		const rows = await scans.latestPerApp();
		expect(rows).toHaveLength(2);
		expect(rows.find((r) => r.appId === 'a1')?.id).toBe(newer.id);
	});
});

describe('ScanStore recommendations', () => {
	const rec = (kind: NewRecommendation['kind'], extra: Partial<NewRecommendation> = {}) => ({
		kind,
		dedupeKey: '',
		severity: 'medium' as const,
		title: `${kind} title`,
		detail: `${kind} detail`,
		autoFixable: false,
		...extra
	});

	it('inserts, dedupes, and keeps dismissed recs suppressed', async () => {
		const { scans } = stores();
		let open = await scans.sync('a1', [rec('add-healthcheck'), rec('run-non-root')]);
		expect(open).toHaveLength(2);

		// Same evaluation twice: still two rows, no duplicates.
		open = await scans.sync('a1', [rec('add-healthcheck'), rec('run-non-root')]);
		expect(open).toHaveLength(2);

		const hc = open.find((r) => r.kind === 'add-healthcheck')!;
		expect(await scans.setStatus(hc.id, 'dismissed')).toBe(true);

		// A dismissed rec never reappears, even when re-evaluated.
		open = await scans.sync('a1', [rec('add-healthcheck'), rec('run-non-root')]);
		expect(open.map((r) => r.kind)).toEqual(['run-non-root']);
		expect((await scans.rec(hc.id))?.status).toBe('dismissed');
	});

	it('deletes resolved open recs and reopens applied recs on regression', async () => {
		const { scans } = stores();
		await scans.sync('a1', [rec('add-healthcheck'), rec('pin-image-tag')]);
		// Condition for pin-image-tag cleared: its open row is removed.
		let open = await scans.sync('a1', [rec('add-healthcheck')]);
		expect(open.map((r) => r.kind)).toEqual(['add-healthcheck']);

		const hc = open[0];
		expect(await scans.setStatus(hc.id, 'applied')).toBe(true);
		expect((await scans.rec(hc.id))?.appliedAt).toBeTruthy();
		// Regression: the same evaluation result reopens the applied rec.
		open = await scans.sync('a1', [rec('add-healthcheck')]);
		expect(open).toHaveLength(1);
		expect(open[0].id).toBe(hc.id);
		expect(open[0].status).toBe('open');
		expect(open[0].appliedAt).toBeUndefined();
	});

	it('scopes dedupe per app and reports open counts', async () => {
		const { scans } = stores();
		await scans.sync('a1', [rec('run-non-root')]);
		await scans.sync('a2', [rec('run-non-root'), rec('add-healthcheck')]);
		const counts = await scans.openCounts();
		expect(counts.get('a1')).toBe(1);
		expect(counts.get('a2')).toBe(2);
		expect(await scans.allOpen()).toHaveLength(3);
		expect(await scans.recsForApp('a2')).toHaveLength(2);
	});

	it('setStatus rejects a second transition', async () => {
		const { scans } = stores();
		const [r] = await scans.sync('a1', [rec('run-non-root')]);
		expect(await scans.setStatus(r.id, 'applied')).toBe(true);
		expect(await scans.setStatus(r.id, 'dismissed')).toBe(false);
	});
});

describe('evaluate', () => {
	const spec: DeploySpec = {
		appId: 'a',
		releaseId: 'r',
		jobKey: 'k',
		source: IMAGE,
		build: { kind: 'image' },
		run: { ports: [], envRef: 'a' },
		route: { domains: ['app.example.com'] },
		runtime: 'docker'
	};

	it('flags an unpinned image tag and marks it fixable with a digest', async () => {
		const { deploys } = stores();
		const imageApp = await mkApp(deploys, 'img-app', IMAGE);
		const pinnedApp = await mkApp(deploys, 'pinned-app', {
			kind: 'image',
			url: 'registry.example.com/app:1.2.3'
		});
		const digest = `registry.example.com/app@sha256:${'a'.repeat(64)}`;
		const recs = evaluate(imageApp, spec, [], { repoDigests: [digest] });
		const pin = recs.find((r) => r.kind === 'pin-image-tag');
		expect(pin).toBeTruthy();
		expect(pin?.autoFixable).toBe(true);
		expect(pin?.data?.ref).toBe(digest);

		// Without a digest the rec is advisory only.
		const noDigest = evaluate(imageApp, spec, [], {}).find((r) => r.kind === 'pin-image-tag');
		expect(noDigest?.autoFixable).toBe(false);

		// A pinned tag produces no rec.
		expect(
			evaluate(pinnedApp, spec, [], {}).find((r) => r.kind === 'pin-image-tag')
		).toBeUndefined();
	});

	it('flags a missing healthcheck as fixable when a port is known', async () => {
		const { deploys } = stores();
		const imageApp = await mkApp(deploys, 'img-app', IMAGE);
		const withPorts = {
			...spec,
			run: { ...spec.run, ports: [{ host: 8080, container: 3000 }] }
		};
		const recs = evaluate(imageApp, withPorts, []);
		const hc = recs.find((r) => r.kind === 'add-healthcheck');
		expect(hc?.autoFixable).toBe(true);
		expect(hc?.data?.port).toBe(3000);

		const healthy = await deploys.updateApp(imageApp.id, {
			healthcheck: { kind: 'tcp', port: 3000 }
		});
		expect(
			evaluate(healthy, withPorts, []).find((r) => r.kind === 'add-healthcheck')
		).toBeUndefined();
	});

	it('flags published ports that bypass the routed domains', async () => {
		const { deploys } = stores();
		const imageApp = await mkApp(deploys, 'img-app', IMAGE);
		const withPorts = {
			...spec,
			run: { ...spec.run, ports: [{ host: 8080, container: 3000 }] }
		};
		const rec = evaluate(imageApp, withPorts, []).find((r) => r.kind === 'unexpose-ports');
		expect(rec).toBeTruthy();
		expect(rec?.autoFixable).toBe(false);
		expect(rec?.detail).toContain('8080:3000');

		// No published ports, or no domains: no rec.
		expect(evaluate(imageApp, spec, []).find((r) => r.kind === 'unexpose-ports')).toBeUndefined();
	});

	it('flags the container running without a user directive', async () => {
		const { deploys } = stores();
		const gitApp = await mkApp(deploys, 'git-app', GIT);
		expect(evaluate(gitApp, spec, []).find((r) => r.kind === 'run-non-root')).toBeTruthy();
		// A spec carrying a non-root user clears it.
		const withUser = {
			...spec,
			run: { ...spec.run, user: 'app' } as DeploySpec['run']
		};
		expect(evaluate(gitApp, withUser, []).find((r) => r.kind === 'run-non-root')).toBeUndefined();
	});

	it('flags critical and high findings with top offenders in the detail', async () => {
		const { deploys } = stores();
		const imageApp = await mkApp(deploys, 'img-app', IMAGE);
		const findings = [
			finding('critical', 'openssl', 'CVE-9'),
			finding('high', 'musl', 'CVE-8'),
			finding('low', 'zlib', 'CVE-7')
		];
		const rec = evaluate(imageApp, spec, findings).find((r) => r.kind === 'upgrade-base-image');
		expect(rec).toBeTruthy();
		expect(rec?.severity).toBe('high');
		expect(rec?.autoFixable).toBe(false);
		expect(rec?.detail).toContain('openssl');
		expect(rec?.detail).toContain('2 critical or high');

		expect(
			evaluate(imageApp, spec, [finding('low')]).find((r) => r.kind === 'upgrade-base-image')
		).toBeUndefined();
	});
});

describe('fixFor', () => {
	it('builds a source patch that pins the digest', async () => {
		const { deploys } = stores();
		const app = await mkApp(deploys, 'fix-app', IMAGE);
		const base = {
			id: 'rec_x',
			appId: app.id,
			dedupeKey: '',
			severity: 'medium' as const,
			title: 't',
			detail: 'd',
			autoFixable: true,
			status: 'open' as const,
			createdAt: 1
		};
		const ref = `registry.example.com/app@sha256:${'b'.repeat(64)}`;
		const rec: Recommendation = { ...base, kind: 'pin-image-tag', data: { ref } };
		const patch = fixFor(rec, app);
		expect(patch?.source?.url).toBe(ref);
		expect(patch?.source?.kind).toBe('image');
	});

	it('builds a healthcheck patch from the suggested port', async () => {
		const { deploys } = stores();
		const app = await mkApp(deploys, 'fix-app', IMAGE);
		const base = {
			id: 'rec_x',
			appId: app.id,
			dedupeKey: '',
			severity: 'medium' as const,
			title: 't',
			detail: 'd',
			autoFixable: true,
			status: 'open' as const,
			createdAt: 1
		};
		const rec: Recommendation = { ...base, kind: 'add-healthcheck', data: { port: 8080 } };
		expect(fixFor(rec, app)?.healthcheck).toEqual({ kind: 'tcp', port: 8080 });
	});

	it('refuses malformed data and non-fixable kinds', async () => {
		const { deploys } = stores();
		const app = await mkApp(deploys, 'fix-app', IMAGE);
		const base = {
			id: 'rec_x',
			appId: app.id,
			dedupeKey: '',
			severity: 'medium' as const,
			title: 't',
			detail: 'd',
			autoFixable: true,
			status: 'open' as const,
			createdAt: 1
		};
		const badPin: Recommendation = { ...base, kind: 'pin-image-tag', data: { ref: 'img:1' } };
		expect(fixFor(badPin, app)).toBeNull();
		const badPort: Recommendation = { ...base, kind: 'add-healthcheck', data: { port: 0 } };
		expect(fixFor(badPort, app)).toBeNull();
		const root: Recommendation = { ...base, kind: 'run-non-root' };
		expect(fixFor(root, app)).toBeNull();
	});
});

describe('enqueueScan and settleScanJob', () => {
	it('enqueues a scan job and dedupes while one is in flight', async () => {
		const { deploys, jobs, scans } = stores();
		const app = await mkApp(deploys, 'scan-app', IMAGE);
		const { job, report, deduped } = await enqueueScan(deploys, jobs, scans, app.id, {});
		expect(deduped).toBe(false);
		expect(job?.kind).toBe('scan');
		expect(job?.target).toBe('agent-1');
		expect((JSON.parse(job!.spec) as ScanJobSpec).imageRef).toBe('registry.example.com/app:latest');
		expect(report.status).toBe('queued');

		const again = await enqueueScan(deploys, jobs, scans, app.id, {});
		expect(again.deduped).toBe(true);
		expect(again.report.id).toBe(report.id);
	});

	it('rejects scans for git apps that were never deployed', async () => {
		const { deploys, jobs, scans } = stores();
		const app = await mkApp(deploys, 'never-dep', GIT);
		await expect(enqueueScan(deploys, jobs, scans, app.id, {})).rejects.toThrow(/nothing to scan/);
	});

	it('settles a succeeded job into a done report and fresh recs', async () => {
		const { deploys, jobs, scans, rt } = stores();
		const app = await mkApp(deploys, 'settle-app', IMAGE);
		const { job, report } = await enqueueScan(deploys, jobs, scans, app.id, {});

		const claimed = (await jobs.claim('scan', 'agent-1'))!;
		expect(claimed.id).toBe(job!.id);
		expect(await jobs.start(job!.id, claimed.lease)).toBe(true);
		await markScanJobRunning(rt, job!.id);
		expect((await scans.report(report.id))?.status).toBe('running');

		const digest = `registry.example.com/app@sha256:${'c'.repeat(64)}`;
		expect(
			await jobs.succeed(job!.id, claimed.lease, {
				scanId: report.id,
				findings: [
					{ vulnId: 'CVE-1', pkg: 'openssl', severity: 'CRITICAL', fixed: '3.0.1' },
					{ vulnId: 'CVE-2', pkg: 'musl', severity: 'LOW' }
				],
				repoDigests: [digest]
			})
		).toBe(true);
		await settleScanJob(rt, job!.id);

		const done = (await scans.report(report.id))!;
		expect(done.status).toBe('done');
		expect(done.summary).toEqual({ critical: 1, high: 0, medium: 0, low: 1, unknown: 0 });
		expect(await scans.findings(report.id)).toHaveLength(2);

		const recs = await scans.recsForApp(app.id);
		const kinds = recs.map((r) => r.kind).sort();
		expect(kinds).toContain('pin-image-tag');
		expect(kinds).toContain('upgrade-base-image');
		expect(kinds).toContain('add-healthcheck');
		expect(recs.find((r) => r.kind === 'pin-image-tag')?.autoFixable).toBe(true);
	});

	it('settles a failed job into a failed report', async () => {
		const { deploys, jobs, scans, rt } = stores();
		const app = await mkApp(deploys, 'fail-app', IMAGE);
		const { job, report } = await enqueueScan(deploys, jobs, scans, app.id, {});
		const claimed = (await jobs.claim('scan', 'agent-1'))!;
		await jobs.start(job!.id, claimed.lease);
		await jobs.fail(job!.id, claimed.lease, { error: 'trivy not installed' });
		// fail() requeues while attempts remain; force the terminal
		// transition to exercise settle.
		const retry = (await jobs.claim('scan', 'agent-1'))!;
		await jobs.start(job!.id, retry.lease);
		expect((await jobs.fail(job!.id, retry.lease, { error: 'trivy not installed' })).status).toBe(
			'failed'
		);
		await settleScanJob(rt, job!.id);
		const done = (await scans.report(report.id))!;
		expect(done.status).toBe('failed');
		expect(done.error).toBe('trivy not installed');
	});

	it('rejects a result whose scan id does not match the spec', async () => {
		const { deploys, jobs, scans, rt } = stores();
		const app = await mkApp(deploys, 'mismatch-app', IMAGE);
		const { job, report } = await enqueueScan(deploys, jobs, scans, app.id, {});
		const claimed = (await jobs.claim('scan', 'agent-1'))!;
		await jobs.start(job!.id, claimed.lease);
		await jobs.succeed(job!.id, claimed.lease, { scanId: 'scan_other', findings: [] });
		await settleScanJob(rt, job!.id);
		expect((await scans.report(report.id))?.status).toBe('failed');
	});
});
