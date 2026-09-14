import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { Runtime } from '$lib/server/runtime';
import type { User } from '$lib/server/admin/users';

// Fake a runtime backed by real stores on a temp db, and stub the
// ingress gates so the scan settle path through the job lifecycle
// route is what actually gets exercised.
const ref = vi.hoisted(() => ({
	rt: undefined as unknown as Runtime,
	audit: [] as { action: string; detail: string | null }[]
}));

vi.mock('$lib/server/runtime', async () => {
	process.env.WHARFINGER_SECRET_KEY = 'route-test-key-material';
	const { mkdtempSync } = await import('node:fs');
	const { join } = await import('node:path');
	const { tmpdir } = await import('node:os');
	const dir = mkdtempSync(join(tmpdir(), 'q4s-scan-routes-'));
	process.env.WHARFINGER_DATA_DIR = dir;
	const { openDb } = await import('$lib/server/store/db');
	const { JobQueue } = await import('$lib/server/jobs/queue');
	const { DeployStore } = await import('$lib/server/deploy/store');
	const db = openDb(dir);
	ref.rt = {
		jobs: new JobQueue(db),
		deploys: new DeployStore(db),
		agents: {},
		audit: { log: (e: { action: string; detail: string | null }) => ref.audit.push(e) },
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

const { POST: runScan } = await import('../../src/routes/admin/api/scan/run/+server');
const { GET: listReports } = await import('../../src/routes/admin/api/scan/reports/+server');
const { GET: getReport } = await import('../../src/routes/admin/api/scan/reports/[id]/+server');
const { GET: listRecs } = await import('../../src/routes/admin/api/scan/recommendations/+server');
const { POST: recAction } =
	await import('../../src/routes/admin/api/scan/recommendations/[id]/+server');
const { POST: claimJobs } = await import('../../src/routes/ingress/jobs/claim/+server');
const { POST: jobAction } = await import('../../src/routes/ingress/jobs/[id]/+server');

const { enqueueScan } = await import('$lib/server/scan/trigger');
const { getScanStore } = await import('$lib/server/scan/store');

const PERMS = new Set(['scan.view', 'scan.manage']);

function event(
	path: string,
	opts: {
		method?: string;
		body?: unknown;
		params?: Record<string, string>;
		perms?: Set<string> | null;
	} = {}
): RequestEvent {
	const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
	return {
		locals:
			opts.perms === null
				? {}
				: { user: { id: 1, username: 'op' } as unknown as User, perms: opts.perms ?? PERMS },
		params: opts.params ?? {},
		url: new URL(`http://test${path}`),
		request: new Request(`http://test${path}`, {
			method,
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
		}),
		getClientAddress: () => '10.0.0.1'
	} as unknown as RequestEvent;
}

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

async function status(fn: (e: never) => unknown, ev: RequestEvent): Promise<number> {
	try {
		await fn(ev as never);
		return 200;
	} catch (e) {
		const s = (e as { status?: unknown }).status;
		return typeof s === 'number' ? s : 0;
	}
}

const IMAGE = { kind: 'image' as const, url: 'registry.example.com/app:latest' };

function mkApp(name: string) {
	return ref.rt.deploys.createApp({ name, agentId: 'agent-1', source: IMAGE }).app;
}

describe('admin scan routes', () => {
	it('rejects anonymous and unprivileged callers', async () => {
		expect(await status(runScan as never, event('/x', { body: {}, perms: null }))).toBe(401);
		expect(
			await status(runScan as never, event('/x', { body: {}, perms: new Set(['scan.view']) }))
		).toBe(403);
		expect(
			await status(listReports as never, event('/x?appId=a', { perms: new Set(['deploy.view']) }))
		).toBe(403);
		expect(
			await status(
				recAction as never,
				event('/x', {
					body: { action: 'dismiss' },
					params: { id: 'r' },
					perms: new Set(['scan.view'])
				})
			)
		).toBe(403);
	});

	it('runs a scan, lists reports, and serves findings', async () => {
		const app = mkApp('route-app');
		const res = await json(
			await runScan(event('/admin/api/scan/run', { body: { appId: app.id } }) as never)
		);
		expect(res.ok).toBe(true);
		const report = res.report as { id: string; status: string; target: string };
		expect(report.status).toBe('queued');
		expect(report.target).toBe('registry.example.com/app:latest');
		expect(ref.audit.some((a) => a.action === 'scan.run')).toBe(true);

		// Trigger dedupe while the first scan is still in flight.
		const again = await json(
			await runScan(event('/admin/api/scan/run', { body: { appId: app.id } }) as never)
		);
		expect(again.deduped).toBe(true);

		// Finish the job through the lifecycle route so later tests do
		// not inherit a queued scan.
		const claim = await json(
			await claimJobs(event('/ingress/jobs/claim', { body: { kinds: ['scan'] } }) as never)
		);
		const claimed = claim.job as { id: number; lease: string };
		await jobAction(
			event(`/ingress/jobs/${claimed.id}`, {
				body: {
					lease: claimed.lease,
					action: 'succeed',
					result: {
						scanId: report.id,
						findings: [{ vulnId: 'CVE-9', pkg: 'zlib', severity: 'low' }]
					}
				},
				params: { id: String(claimed.id) }
			}) as never
		);

		const list = await json(
			await listReports(event(`/admin/api/scan/reports?appId=${app.id}`) as never)
		);
		expect((list.reports as unknown[]).length).toBe(1);

		const detail = await json(
			await getReport(
				event(`/admin/api/scan/reports/${report.id}`, { params: { id: report.id } }) as never
			)
		);
		expect((detail.report as { id: string }).id).toBe(report.id);
		expect(detail.findings).toHaveLength(1);

		const missing = await json(
			await getReport(event('/admin/api/scan/reports/nope', { params: { id: 'nope' } }) as never)
		);
		expect(missing.error).toBe('report not found');
	});

	it('rejects a scan for an unknown app and a missing appId', async () => {
		const res = await json(
			await runScan(event('/admin/api/scan/run', { body: { appId: 'app_ghost' } }) as never)
		);
		expect(res.error).toBe('app not found');
		const noId = await json(await runScan(event('/admin/api/scan/run', { body: {} }) as never));
		expect(noId.error).toBe('appId is required');
	});

	it('applies a fixable rec through the app update path and audits it', async () => {
		const app = mkApp('fix-app');
		const scans = getScanStore(ref.rt.db);
		const digest = `registry.example.com/app@sha256:${'d'.repeat(64)}`;
		const [rec] = scans.sync(app.id, [
			{
				kind: 'pin-image-tag',
				dedupeKey: '',
				severity: 'medium',
				title: 'pin it',
				detail: 'pin it',
				autoFixable: true,
				data: { ref: digest }
			},
			{
				kind: 'run-non-root',
				dedupeKey: '',
				severity: 'low',
				title: 'no fix',
				detail: 'no fix',
				autoFixable: false
			}
		]);

		const res = await json(
			await recAction(
				event(`/admin/api/scan/recommendations/${rec.id}`, {
					body: { action: 'apply' },
					params: { id: rec.id }
				}) as never
			)
		);
		expect(res.ok).toBe(true);
		expect((res.rec as { status: string }).status).toBe('applied');
		expect(ref.rt.deploys.getApp(app.id)?.source.url).toBe(digest);
		expect(
			ref.audit.some((a) => a.action === 'deploy.app.autofix' && a.detail?.includes(digest))
		).toBe(true);

		// A second apply is a conflict, not a double mutation.
		const again = await recAction(
			event(`/admin/api/scan/recommendations/${rec.id}`, {
				body: { action: 'apply' },
				params: { id: rec.id }
			}) as never
		);
		expect(again.status).toBe(409);

		// A non-fixable rec cannot be applied.
		const noFix = scans.recsForApp(app.id).find((r) => r.kind === 'run-non-root')!;
		const nf = await recAction(
			event(`/admin/api/scan/recommendations/${noFix.id}`, {
				body: { action: 'apply' },
				params: { id: noFix.id }
			}) as never
		);
		expect(nf.status).toBe(409);

		// Dismiss marks the rec and audits it.
		const dis = await json(
			await recAction(
				event(`/admin/api/scan/recommendations/${noFix.id}`, {
					body: { action: 'dismiss' },
					params: { id: noFix.id }
				}) as never
			)
		);
		expect(dis.ok).toBe(true);
		expect((dis.rec as { status: string }).status).toBe('dismissed');
		expect(ref.audit.some((a) => a.action === 'scan.rec.dismiss')).toBe(true);
	});

	it('settles a scan through the ingress job lifecycle route', async () => {
		const app = mkApp('ing-app');
		const scans = getScanStore(ref.rt.db);
		const { job, report } = enqueueScan(ref.rt.deploys, ref.rt.jobs, scans, app.id, {});

		const claim = await json(
			await claimJobs(event('/ingress/jobs/claim', { body: { kinds: ['scan'] } }) as never)
		);
		const claimed = claim.job as { id: number; lease: string };
		expect(claimed.id).toBe(job!.id);

		await jobAction(
			event(`/ingress/jobs/${job!.id}`, {
				body: { lease: claimed.lease, action: 'start' },
				params: { id: String(job!.id) }
			}) as never
		);
		expect(scans.report(report.id)?.status).toBe('running');

		const res = await json(
			await jobAction(
				event(`/ingress/jobs/${job!.id}`, {
					body: {
						lease: claimed.lease,
						action: 'succeed',
						result: {
							scanId: report.id,
							findings: [{ vulnId: 'CVE-1', pkg: 'openssl', severity: 'CRITICAL' }]
						}
					},
					params: { id: String(job!.id) }
				}) as never
			)
		);
		expect(res.ok).toBe(true);
		const done = scans.report(report.id)!;
		expect(done.status).toBe('done');
		expect(done.summary.critical).toBe(1);
		// The settle pass also refreshes recommendations for the app.
		expect(scans.recsForApp(app.id).length).toBeGreaterThan(0);

		const list = await json(
			await listRecs(event(`/admin/api/scan/recommendations?appId=${app.id}`) as never)
		);
		expect((list.recommendations as unknown[]).length).toBeGreaterThan(0);
	});
});
