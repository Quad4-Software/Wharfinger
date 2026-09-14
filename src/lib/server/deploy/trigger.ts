import { randomBytes } from 'node:crypto';
import type { Runtime } from '$lib/server/runtime';
import type { DeployApp, DeploySpec, Healthcheck } from '$lib/shared/deploy';
import { DeployError } from './store';
import type { Job } from '$lib/shared/jobs';

function buildSpec(
	rt: Runtime,
	app: DeployApp,
	releaseId: string,
	rollbackOf?: string
): DeploySpec {
	const live = rt.deploys.liveRelease(app.id);
	// Static apps publish files, not containers: ports and
	// healthchecks are meaningless and must not leak into the spec.
	const isStatic = app.source.kind === 'static';
	const build =
		app.source.kind === 'image'
			? { kind: 'image' as const }
			: app.source.kind === 'static'
				? { kind: 'static' as const, context: app.source.subdir }
				: { kind: 'dockerfile' as const };
	const spec: DeploySpec = {
		appId: app.id,
		releaseId,
		jobKey: `deploy:${app.id}:${releaseId}`,
		source: app.source,
		build,
		run: {
			// Explicit port mappings win; an app that declares domains
			// but no ports falls back to publishing its healthcheck port
			// (localhost-bound) so the edge proxy and the k8s ClusterIP
			// service have an upstream without exposing the port publicly.
			ports: isStatic
				? []
				: app.ports.length > 0
					? app.ports
					: app.domains.length > 0 && app.healthcheck.port
						? [{ host: app.healthcheck.port, container: app.healthcheck.port, local: true }]
						: [],
			healthcheck:
				!isStatic && app.healthcheck.port && app.healthcheck.kind
					? (app.healthcheck as Healthcheck)
					: undefined,
			envRef: app.id,
			...(app.replicas ? { replicas: app.replicas } : {})
		},
		route: { domains: app.domains },
		runtime: app.runtime,
		...(app.namespace ? { namespace: app.namespace } : {}),
		...(rollbackOf ? { rollbackOf } : {}),
		...(live
			? {
					prevRelease: {
						id: live.id,
						container: `${app.id}-${live.id}`,
						image: live.image
					}
				}
			: {})
	};
	return spec;
}

/**
 * Enqueue a deploy for an app. The spec is frozen here; the job key
 * dedupes repeat triggers for the same release, and the release row
 * records the immutable history entry. maxAttempts is 1: a stale
 * deploy claim goes to 'unknown' for reconciliation rather than
 * blindly re-running a possibly-half-applied deploy.
 */
export function triggerDeploy(
	rt: Runtime,
	app: DeployApp,
	opts: { rollbackTo?: string; jobKey?: string } = {}
): { job: Job; releaseId: string | null; deduped: boolean } {
	let spec: DeploySpec;
	let releaseId: string;

	if (opts.rollbackTo) {
		const frozen = rt.deploys.releaseSpec(opts.rollbackTo);
		if (!frozen) throw new DeployError(404, 'target release not found');
		const prior = JSON.parse(frozen) as DeploySpec;
		if (prior.appId !== app.id) throw new DeployError(422, 'release belongs to another app');
		releaseId = `rel_${randomBytes(9).toString('base64url')}`;
		spec = {
			...prior,
			releaseId,
			rollbackOf: opts.rollbackTo,
			jobKey: `deploy:${app.id}:${releaseId}`
		};
	} else {
		releaseId = `rel_${randomBytes(9).toString('base64url')}`;
		spec = buildSpec(rt, app, releaseId);
	}
	if (opts.jobKey) spec.jobKey = opts.jobKey;

	// Delivery dedupe: a repeated webhook for the same push must not
	// mint a second release + job.
	const existing = rt.jobs.byKey(spec.jobKey);
	if (existing) return { job: existing, releaseId: null, deduped: true };

	const release = rt.deploys.createRelease(app.id, JSON.stringify(spec), null, releaseId);
	const { job } = rt.jobs.enqueue({
		kind: 'deploy',
		target: app.agentId,
		spec,
		jobKey: spec.jobKey,
		maxAttempts: 1
	});
	rt.deploys.linkJob(release.id, job.id);
	return { job, releaseId: release.id, deduped: false };
}

/**
 * Map a finished deploy job onto its release record. Called from the
 * job lifecycle route after a terminal transition.
 */
export function settleDeployJob(rt: Runtime, jobId: number): void {
	const job = rt.jobs.get(jobId);
	if (job?.kind !== 'deploy' || !job.result) return;
	let releaseId: string | undefined;
	try {
		releaseId = (JSON.parse(job.spec) as DeploySpec).releaseId;
	} catch {
		return;
	}
	if (!releaseId) return;
	const result = JSON.parse(job.result) as {
		commit?: string;
		image?: string;
		container?: string;
	};
	const meta = { commit: result.commit, image: result.image };
	if (job.status === 'succeeded') rt.deploys.markLive(releaseId, meta);
	else if (job.status === 'rolled_back') rt.deploys.markRelease(releaseId, 'rolled_back', meta);
	else if (job.status === 'failed') rt.deploys.markRelease(releaseId, 'failed', meta);
}
