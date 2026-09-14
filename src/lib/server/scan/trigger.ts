import type { Runtime } from '$lib/server/runtime';
import type { DeployStore } from '$lib/server/deploy/store';
import { DeployError } from '$lib/server/deploy/store';
import type { JobQueue } from '$lib/server/jobs/queue';
import type { DeploySpec } from '$lib/shared/deploy';
import type { Job } from '$lib/shared/jobs';
import type {
	ScanFinding,
	ScanJobResult,
	ScanJobSpec,
	ScanReport,
	ScanWireFinding
} from '$lib/shared/scan';
import { MAX_FINDINGS_PER_REPORT } from '$lib/shared/scan';
import type { ScanStore } from './store';
import { getScanStore } from './store';
import { evaluate } from './recommend';

// Same fold the agent applies when tagging local builds, so a live
// release without a recorded image still resolves to the tag the
// executor pushed into the local runtime.
function foldTag(v: string): string {
	return v
		.toLowerCase()
		.replace(/[^a-z0-9_.-]/g, '-')
		.slice(0, 128);
}

function specImage(spec: DeploySpec | null): string | undefined {
	if (!spec) return undefined;
	if (spec.run.image) return spec.run.image;
	if (spec.source.kind === 'image' && spec.source.url) return spec.source.url;
	return undefined;
}

function releaseSpec(deploys: DeployStore, releaseId: string): DeploySpec | null {
	const raw = deploys.releaseSpec(releaseId);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as DeploySpec;
	} catch {
		return null;
	}
}

/**
 * Resolve which image reference a scan should target: an explicit
 * release's recorded image (or its frozen spec), the live release,
 * or the app's image source. Built images fall back to the local
 * <app>:<release> tag the executor used.
 */
function resolveTarget(
	deploys: DeployStore,
	appId: string,
	releaseId?: string
): { imageRef: string; releaseId?: string } {
	const app = deploys.getApp(appId);
	if (!app) throw new DeployError(404, 'app not found');

	let relId = releaseId;
	if (relId) {
		const rel = deploys.release(relId);
		if (!rel) throw new DeployError(404, 'release not found');
		if (rel.appId !== appId) throw new DeployError(422, 'release belongs to another app');
		const ref = rel.image ?? specImage(releaseSpec(deploys, relId));
		if (ref) return { imageRef: ref, releaseId: relId };
		return { imageRef: `${foldTag(appId)}:${foldTag(relId)}`, releaseId: relId };
	}

	const live = deploys.liveRelease(appId);
	if (live) {
		relId = live.id;
		const ref = live.image ?? specImage(releaseSpec(deploys, live.id));
		if (ref) return { imageRef: ref, releaseId: relId };
		return { imageRef: `${foldTag(appId)}:${foldTag(live.id)}`, releaseId: relId };
	}

	if (app.source.kind === 'image' && app.source.url) {
		return { imageRef: app.source.url };
	}
	throw new DeployError(422, 'nothing to scan yet: deploy the app or use an image source');
}

/**
 * Enqueue a trivy scan for an app. The report row is created in
 * 'queued' so the panel can show the pending scan; the job spec is a
 * frozen snapshot targeting the app's agent. A scan already in
 * flight for the app dedupes instead of queueing a second agent run.
 */
export function enqueueScan(
	deploys: DeployStore,
	jobs: JobQueue,
	scans: ScanStore,
	appId: string,
	opts: { releaseId?: string } = {}
): { job: Job | null; report: ScanReport; deduped: boolean } {
	const app = deploys.getApp(appId);
	if (!app) throw new DeployError(404, 'app not found');

	const active = scans.activeForApp(appId);
	if (active) {
		const existing = jobs.byKey(`scan:${appId}:${active.id}`);
		if (existing) return { job: existing, report: active, deduped: true };
		// The report outlived its job row (pruned or unknown): close
		// it out so the app is not blocked from scanning forever.
		scans.complete(active.id, 'failed', { error: 'scan job lost before completion' });
	}

	const { imageRef, releaseId } = resolveTarget(deploys, appId, opts.releaseId);
	const report = scans.createReport({ appId, target: imageRef, releaseId });
	const spec: ScanJobSpec = {
		scanId: report.id,
		appId,
		imageRef,
		releaseId,
		jobKey: `scan:${appId}:${report.id}`
	};
	const { job } = jobs.enqueue({
		kind: 'scan',
		target: app.agentId,
		spec,
		jobKey: spec.jobKey,
		// Scans are read-only and idempotent: a re-run just re-scans
		// the same image, so one retry on a dead claim is safe.
		maxAttempts: 2
	});
	return { job, report, deduped: false };
}

function scanSpec(job: Job): ScanJobSpec | null {
	try {
		const spec = JSON.parse(job.spec) as ScanJobSpec;
		return typeof spec.scanId === 'string' && typeof spec.imageRef === 'string' ? spec : null;
	} catch {
		return null;
	}
}

/** The agent posted 'start': flip the queued report to running. */
export function markScanJobRunning(rt: Runtime, jobId: number): void {
	const job = rt.jobs.get(jobId);
	if (job?.kind !== 'scan') return;
	const spec = scanSpec(job);
	if (!spec) return;
	getScanStore(rt.db).markRunning(spec.scanId);
}

function wireFindings(result: ScanJobResult): Omit<ScanFinding, 'reportId'>[] {
	const raw: unknown[] = Array.isArray(result.findings) ? result.findings : [];
	const out: Omit<ScanFinding, 'reportId'>[] = [];
	for (const f of raw.slice(0, MAX_FINDINGS_PER_REPORT)) {
		if (!f || typeof f !== 'object') continue;
		const w = f as ScanWireFinding;
		if (typeof w.vulnId !== 'string' || typeof w.pkg !== 'string') continue;
		out.push({
			vulnId: w.vulnId,
			pkg: w.pkg,
			installed: typeof w.installed === 'string' ? w.installed : undefined,
			fixed: typeof w.fixed === 'string' ? w.fixed : undefined,
			severity: w.severity as ScanFinding['severity'],
			title: typeof w.title === 'string' ? w.title : undefined,
			cvss: typeof w.cvss === 'number' ? w.cvss : undefined
		});
	}
	return out;
}

/**
 * Map a finished scan job onto its report and refresh the app's
 * recommendations. Called from the job lifecycle route after a
 * terminal transition; no-ops for non-scan jobs.
 */
export function settleScanJob(rt: Runtime, jobId: number): void {
	const job = rt.jobs.get(jobId);
	if (job?.kind !== 'scan' || !job.result) return;
	const spec = scanSpec(job);
	if (!spec) return;
	const scans = getScanStore(rt.db);

	if (job.status !== 'succeeded') {
		let error = 'scan job failed';
		try {
			const r = JSON.parse(job.result) as { error?: unknown };
			if (typeof r.error === 'string' && r.error) error = r.error;
		} catch {
			// keep the generic message
		}
		scans.complete(spec.scanId, 'failed', { error });
		return;
	}

	let result: ScanJobResult;
	try {
		result = JSON.parse(job.result) as ScanJobResult;
	} catch {
		scans.complete(spec.scanId, 'failed', { error: 'malformed scan result' });
		return;
	}
	if (result.scanId !== spec.scanId) {
		scans.complete(spec.scanId, 'failed', { error: 'scan id mismatch in result' });
		return;
	}
	const report = scans.complete(spec.scanId, 'done', {
		findings: wireFindings(result)
	});
	if (report?.status !== 'done') return;

	const app = rt.deploys.getApp(spec.appId);
	if (!app) return;
	const relSpec = spec.releaseId ? releaseSpec(rt.deploys, spec.releaseId) : null;
	const recs = evaluate(app, relSpec, scans.findings(spec.scanId), {
		imageRef: spec.imageRef,
		repoDigests: Array.isArray(result.repoDigests)
			? result.repoDigests.filter((d): d is string => typeof d === 'string').slice(0, 8)
			: []
	});
	scans.sync(spec.appId, recs);
}
